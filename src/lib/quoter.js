'use strict'

const ILQP = require('ilp').ILQP
const IlpPacket = require('ilp-packet')
const LiquidityCurve = require('ilp-routing').LiquidityCurve
const InvalidAmountSpecifiedError = require('../errors/invalid-amount-specified-error')

/**
 * @param {Ledgers} ledgers
 * @param {Object} request
 * @param {IlpAddress} request.sourceAccount
 * @param {IlpAddress} request.destinationAccount
 * @param {Integer} request.destinationHoldDuration
 * @param {Integer} request.quoteExpiryDuration milliseconds
 * @returns {Object}
 */
function * quoteLiquidity (ledgers, request) {
  const destinationHoldDuration = request.destinationHoldDuration
  const routesByConnector = ledgers.tables.findRoutes(
    request.sourceAccount, request.destinationAccount)
  if (!routesByConnector.size) return null

  let sourceLedger
  const quoteResponsePromises = []
  for (const nextConnector of routesByConnector.keys()) {
    const route = routesByConnector.get(nextConnector)
    sourceLedger = route.sourceLedger
    if (route.isLocal) {
      quoteResponsePromises.push(Promise.resolve({
        liquidityCurve: route.curve,
        appliesToPrefix: route.appliesToPrefix,
        sourceHoldDuration: destinationHoldDuration + route.minMessageWindow,
        expiresAt: Date.now() + request.quoteExpiryDuration
      }))
      continue
    }
    //TODO shouldn't the liquidity curve returned be joined to a local one?
    quoteResponsePromises.push(quoteCurveByConnector({
      plugin: ledgers.getPlugin(route.nextLedger),
      connector: nextConnector,
      quoteQuery: {
        destinationAccount: request.destinationAccount,
        destinationHoldDuration
      }
    }))
  }
  const quoteResponses = yield Promise.all(quoteResponsePromises)
  const combinedResponse = combineCurveResponses(quoteResponses)
  combinedResponse.liquidityCurve = combinedResponse.liquidityCurve.toBuffer().toString('base64')
  combinedResponse.expiresAt = new Date(combinedResponse.expiresAt)

  return Object.assign({
    sourceLedger,
    destinationHoldDuration
  }, combinedResponse)
}

function combineCurveResponses (curveResponses) {
  let curve
  return curveResponses.reduce((combinedResponse, nextResponse) => {
    const nextCurve = new LiquidityCurve(nextResponse.liquidityCurve)
    curve = curve ? curve.combine(nextCurve) : nextCurve
    return {
      liquidityCurve: curve,
      appliesToPrefix: maxLength(
        combinedResponse.appliesToPrefix, nextResponse.appliesToPrefix),
      sourceHoldDuration: Math.min(
        combinedResponse.sourceHoldDuration, nextResponse.sourceHoldDuration),
      expiresAt: Math.min(
        combinedResponse.expiresAt, nextResponse.expiresAt)
    }
  })
}

function maxLength (prefix1, prefix2) {
  return prefix1.length > prefix2.length ? prefix1 : prefix2
}

/**
 * @param {Ledgers} ledgers
 * @param {Object} request
 * @param {IlpAddress} request.sourceAccount
 * @param {IlpAddress} request.destinationAccount
 * @param {String} request.sourceAmount
 * @param {Integer} request.destinationHoldDuration
 * @returns {Object}
 */
function * quoteBySourceAmount (ledgers, request) {
  if (request.sourceAmount === '0') {
    throw new InvalidAmountSpecifiedError('sourceAmount must be positive')
  }
  return yield quoteByAmount(ledgers, request,
    IlpPacket.serializeIlqpBySourceRequest,
    IlpPacket.deserializeIlqpBySourceResponse)
}

/**
 * @param {Ledgers} ledgers
 * @param {Object} request
 * @param {IlpAddress} request.sourceAccount
 * @param {IlpAddress} request.destinationAccount
 * @param {String} request.destinationAmount
 * @param {Integer} request.destinationHoldDuration
 * @returns {Object}
 */
function * quoteByDestinationAmount (ledgers, request) {
  if (request.destinationAmount === '0') {
    throw new InvalidAmountSpecifiedError('destinationAmount must be positive')
  }
  return yield quoteByAmount(ledgers, request,
    IlpPacket.serializeIlqpByDestinationRequest,
    IlpPacket.deserializeIlqpByDestinationResponse)
}

function * quoteByAmount (ledgers, request) {
  const destinationHoldDuration = request.destinationHoldDuration
  const hop = findBestHopForAmount(ledgers, request)
  if (!hop) return null

  // If we know a local route to the destinationAccount, use the local route.
  // Otherwise, ask a connector closer to the destination.
  if (hop.isLocal) return hopToQuote(hop, destinationHoldDuration)

  let headHop
  const intermediateConnector = hop.destinationCreditAccount
  // Quote by source amount
  if (request.sourceAmount) {
    headHop = ledgers.tables.findBestHopForSourceAmount(
      hop.sourceLedger, intermediateConnector, request.sourceAmount)
  }

  //TODO make sure this is tested in quoteSpec (see ilp-core)
  const tailQuote = yield quoteCurveByConnector({
    plugin: ledgers.getPlugin(hop.destinationLedger),
    connector: intermediateConnector,
    quoteQuery: {
      destinationAccount: request.destinationAccount,
      destinationHoldDuration
    }
  })

  // Quote by destination amount
  if (request.destinationAmount) {
    const tailCurve = new LiquidityCurve(tailQuote.liquidityCurve)
    const intermediateSourceAmount = tailCurve.amountReverse(hop.finalAmount)
    headHop = ledgers.tables.findBestHopForDestinationAmount(
      hop.sourceLedger, intermediateConnector, intermediateSourceAmount)
  }

  return {
    sourceLedger: hop.sourceLedger,
    nextLedger: headHop.destinationLedger,
    sourceAmount: headHop.sourceAmount,
    destinationAmount: tailQuote.destinationAmount,
    sourceHoldDuration: tailQuote.sourceHoldDuration + headHop.minMessageWindow,
    destinationHoldDuration
  }
}

function quoteCurveByConnector (params) {
  //TODO check the cache first
  const sourceLedger = params.plugin.getInfo().prefix
  return ILQP.quoteByConnector(params).then((quote) => {
    curveCaches.get(sourceLedger).insert(Object.assign({
      nextHop: params.connector
    }, quote))
    return quote
  })
}

function hopToQuote (hop, destinationHoldDuration) {
  return {
    sourceLedger: hop.sourceLedger,
    nextLedger: hop.destinationLedger,
    sourceAmount: hop.sourceAmount,
    destinationAmount: hop.finalAmount,
    sourceHoldDuration: destinationHoldDuration + hop.minMessageWindow,
    destinationHoldDuration
  }
}

function findBestHopForAmount (ledgers, query) {
  return query.sourceAmount === undefined
    ? ledgers.tables.findBestHopForDestinationAmount(
        query.sourceAccount, query.destinationAccount, query.destinationAmount)
    : ledgers.tables.findBestHopForSourceAmount(
        query.sourceAccount, query.destinationAccount, query.sourceAmount)
}

module.exports = {
  quoteLiquidity,
  quoteBySourceAmount,
  quoteByDestinationAmount
}
