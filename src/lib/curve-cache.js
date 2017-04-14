'use strict'
const BigNumber = require('bignumber.js')
const {LiquidityCurve, PrefixMap} = require('ilp-routing')

// TODO How should the sourceHoldDuration get factored into this?
class CurveCache {
  constructor (params) {
    this.quoteExpiryDuration = params.quoteExpiry
    this.destinations = new PrefixMap()
  }

  removeExpiredQuotes () {
    //TODO
  }

  /**
   * @param {IlqpLiquidityResponse} liquidityQuote
   */
  insert (liquidityQuote) {
    const appliesToPrefix = liquidityQuote.appliesToPrefix
    let quotes = this.destinations.get(appliesToPrefix)
    if (!quotes) {
      quotes = []
      this.destinations.insert(appliesToPrefix, quotes)
    }
    quotes.push(liquidityQuote)
  }

  /**
   * @param {IlpAddress} destination
   * @param {Amount} sourceAmount
   * @returns {Object}
   */
  findBestPathForSourceAmount (destination, sourceAmount) {
    const quotesFromAToC = this.destinations.resolve(destination)
    if (!quotesFromAToC) return

    let bestQuote = null
    let bestValue = null
    for (const quote of quotesFromAToC) {
      if (isExpired(quote)) continue
      const destinationAmount = new BigNumber(quote.liquidityCurve.amountAt(sourceAmount))
      if (!bestValue || bestValue.lt(destinationAmount)) {
        bestValue = destinationAmount
        bestQuote = quote
      }
    }

    //const quotesFromAToB = this._getLocalQuotes(bestQuote.destinationLedger)
    return {
      isFinal: quote.nextLedger === finalLedger,
      destinationLedger: quote.nextLedger,
      destinationCreditAccount: quote.nextConnector,
      destinationAmount:
      finalLedger: 
      finalAmount:
      //bestValue.toString()
    }
  }

  /*_getLocalQuotes (destination) {
    const quotes = this.destinations.resolve(destination)
    if (!quotes) return []
    return quotes.filter((quote) => {
      return quote.nextConnector === null
    })
  }*/
}

function isExpired (quote) {
  //TODO
}

module.exports = CurveCache
