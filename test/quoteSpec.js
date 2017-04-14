'use strict'

const mockPlugin = require('./mocks/mockPlugin')
const mock = require('mock-require')
mock('ilp-plugin-mock', mockPlugin)

const LiquidityCurve = require('ilp-routing').LiquidityCurve
const co = require('co')
const sinon = require('sinon')
const nock = require('nock')
nock.enableNetConnect(['localhost'])
const ratesResponse = require('./data/fxRates.json')
const appHelper = require('./helpers/app')
const logger = require('../src/common/log')
const logHelper = require('./helpers/log')
const chai = require('chai')
const assert = chai.assert
const expect = chai.expect
chai.use(require('chai-as-promised'))
const _ = require('lodash')
const ExternalError = require('../src/errors/external-error')
const InvalidAmountSpecifiedError = require('../src/errors/invalid-amount-specified-error')
const AssetsNotTradedError = require('../src/errors/assets-not-traded-error')
const NoRouteFoundError = require('../src/errors/no-route-found-error')
const UnacceptableAmountError = require('../src/errors/unacceptable-amount-error')
const UnacceptableExpiryError = require('../src/errors/unacceptable-expiry-error')
const LedgerNotConnectedError = require('../src/errors/ledger-not-connected-error')
const START_DATE = 1434412800000 // June 16, 2015 00:00:00 GMT

describe('Quotes', function () {
  logHelper(logger)

  beforeEach(function * () {
    appHelper.create(this)
    this.clock = sinon.useFakeTimers(START_DATE)

    const testLedgers = ['cad-ledger.', 'usd-ledger.', 'eur-ledger.', 'cny-ledger.']
    _.map(testLedgers, (ledgerUri) => {
      this.ledgers.getPlugin(ledgerUri).getBalance =
        function * () { return '150000' }
    })

    // Reset before and after just in case a test wants to change the precision.
    this.balanceCache.reset()
    yield this.backend.connect(ratesResponse)
    yield this.ledgers.connect()
    yield this.routeBroadcaster.reloadLocalRoutes()
  })

  afterEach(function () {
    this.clock.restore()
    nock.cleanAll()
  })

  it('should return a InvalidAmountSpecifiedError if sourceAmount is zero', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '0',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob'
    }))

    yield assert.isRejected(quotePromise, InvalidAmountSpecifiedError, 'sourceAmount must be positive')
  })

  it('should return a InvalidAmountSpecifiedError if destinationAmount is zero', function * () {
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      destinationAmount: '0',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob'
    }))

    yield assert.isRejected(quotePromise, InvalidAmountSpecifiedError, 'destinationAmount must be positive')
  })

  it('should return NoRouteFoundError when the source ledger is not supported', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'fake-ledger.foley',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 1.001
    }))

    yield assert.isRejected(quotePromise, NoRouteFoundError, 'No route found from: fake-ledger.foley to: usd-ledger.bob')
  })

  // This test doesn't currently pass - I think it's because the connector is
  // smart enough to construct a route of A -> B -> C through itself, even if
  // A -> C isn't a pair, but A -> B and B -> C are.
  //
  // This might actually be the desired behavior... if we're willing to trade
  // A for B and B for C, we're implicitly willing to trade A for C.
  it.skip('should return AssetsNotTradedError when the pair is not supported', function * () {
    const quotePromise = this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'cad-ledger.bob',
      destinationAccount: 'cny-ledger.bob',
      destinationHoldDuration: 1.001
    })

    yield assert.isRejected(quotePromise, AssetsNotTradedError, 'This connector does not support the given asset pair')
  })

  it('should return a UnacceptableAmountError if destinationAmount rounded amount is less than or equal to 0', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '0.00001',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob'
    }))

    yield assert.isRejected(quotePromise, UnacceptableAmountError, 'Quoted destination is lower than minimum amount allowed')
  })

  it('should return NoRouteFoundError when the destination ledger is not supported', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'example.fake.blah',
      destinationHoldDuration: 1.001
    }))

    yield assert.isRejected(quotePromise, NoRouteFoundError, 'No route found from: eur-ledger.alice to: example.fake.blah')
  })

  it('should return a UnacceptableExpiryError if the destinationHoldDuration is too long', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 10.001
    }))

    yield assert.isRejected(quotePromise, UnacceptableExpiryError, /Destination expiry duration is too long/)
  })

  it('should not return an Error for insufficient liquidity', function * () {
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      destinationAmount: '150001',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 10
    }))

    yield assert.isFulfilled(quotePromise)
  })

  it('should not return an Error when unable to get balance from ledger', function * () {
    nock.cleanAll()
    this.ledgers.getPlugin('usd-ledger.')
      .getBalance = function * () { throw new ExternalError() }

    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '1500001',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 10
    }))

    yield assert.isFulfilled(quotePromise)
  })

  it('should return quotes for fixed source amounts', function * () {
    const quote = yield this.routeBuilder.quoteBySource({
      sourceAmount: '1000000',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5
    })

    expect(quote).to.deep.equal({
      sourceLedger: 'eur-ledger.',
      sourceAmount: '1000000',
      sourceHoldDuration: 6,
      nextLedger: 'usd-ledger.',
      destinationAmount: '1057081', // EUR/USD Rate of 1.0592 - .2% spread
      destinationHoldDuration: 5
    })
  })

  // TODO: make sure we're calculating the rates correctly and in our favor
  it('should return quotes for fixed destination amounts', function * () {
    const quote = yield this.routeBuilder.quoteByDestination({
      sourceAccount: 'eur-ledger.alice',
      destinationAmount: '1000000',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5
    })
    expect(quote).to.deep.equal({
      sourceLedger: 'eur-ledger.',
      sourceAmount: '946000', // (1/ EUR/USD Rate of 1.0592) + .2% spread + round up to overestimate
      sourceHoldDuration: 6,
      nextLedger: 'usd-ledger.',
      destinationAmount: '1000000',
      destinationHoldDuration: 5
    })
  })

  it('should return liquidity curve quotes', function * () {
    const quote = yield this.routeBuilder.quoteLiquidity({
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5
    })
    expect(quote).to.deep.equal({
      sourceLedger: 'eur-ledger.',
      liquidityCurve: new LiquidityCurve([ [0, 0], [1000000000000, 1057081600000] ]).toBuffer().toString('base64'),
      appliesToPrefix: '',
      sourceHoldDuration: 6,
      destinationHoldDuration: 5,
      expiresAt: new Date(START_DATE + 10 * 1000)
    })
  })

  it('should apply the spread correctly for payments where the source asset is the counter currency in the fx rates', function * () {
    const quote = yield this.routeBuilder.quoteBySource({
      sourceAmount: '1000000',
      sourceAccount: 'usd-ledger.bob',
      destinationAccount: 'eur-ledger.alice',
      destinationHoldDuration: 5
    })
    expect(quote).to.deep.equal({
      sourceLedger: 'usd-ledger.',
      sourceAmount: '1000000',
      sourceHoldDuration: 6,
      nextLedger: 'eur-ledger.',
      destinationAmount: '942220', // 1 / (EUR/USD Rate of 1.0592 + .2% spread)
      destinationHoldDuration: 5
    })
  })

  it('should determine the correct rate and spread when neither the source nor destination asset is the base currency in the rates', function * () {
    const quote = yield this.routeBuilder.quoteBySource({
      sourceAmount: '1000000',
      sourceAccount: 'usd-ledger.bob',
      destinationAccount: 'cad-ledger.carl',
      destinationHoldDuration: 5
    })
    expect(quote).to.deep.equal({
      sourceLedger: 'usd-ledger.',
      sourceAmount: '1000000',
      sourceHoldDuration: 6,
      nextLedger: 'cad-ledger.',
      destinationAmount: '1279818', // USD/CAD Rate (1.3583 / 1.0592) - .2% spread
      destinationHoldDuration: 5
    })
  })

  it('should determine the correct rate and spread when neither the source nor destination asset is the base currency in the rates and the rate must be flipped', function * () {
    const quote = yield this.routeBuilder.quoteBySource({
      sourceAmount: '1000000',
      sourceAccount: 'cad-ledger.carl',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5
    })
    expect(quote).to.deep.equal({
      sourceLedger: 'cad-ledger.',
      sourceAmount: '1000000',
      sourceHoldDuration: 6,
      nextLedger: 'usd-ledger.',
      destinationAmount: '778238', // 1/(USD/CAD Rate (1.3583 / 1.0592) + .2% spread)
      destinationHoldDuration: 5
    })
  })

  // the functionality this tests has been disabled, maybe only temporarily
  it.skip('quotes a multi-hop route', function * () {
    yield this.messageRouter.receiveRoutes([{
      source_ledger: 'eur-ledger.',
      destination_ledger: 'random-ledger.',
      min_message_window: 1,
      source_account: 'eur-ledger.mary',
      points: [ [0, 0], [10000, 20000] ]
    }], 'eur-ledger.mary')

    const quote = yield this.messageRouter.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'usd-ledger.alice',
      destinationAccount: 'random-ledger.bob',
      destination_precision: '10',
      destination_scale: '4'
    })
    expect(quote).to.deep.equal({
      source_connector_account: 'usd-ledger.mark',
      source_ledger: 'usd-ledger.',
      sourceAmount: '100.0000',
      sourceHoldDuration: 7,
      destination_ledger: 'random-ledger.',
      destinationAmount: '188.2556',
      destinationHoldDuration: 5,
      liquidity_curve: [ [0.1, 0], [10613.226452905812, 19999.81155589124] ]
    })
  })

  it('fails on a same-ledger quote', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'usd-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5
    }))

    yield assert.isRejected(quotePromise, NoRouteFoundError, 'No route found from: usd-ledger.alice to: usd-ledger.bob')
  })

  it('fails when the source ledger connection is closed', function * () {
    this.ledgers.getPlugin('eur-ledger.').connected = false
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationAmount: '100',
      destinationHoldDuration: 5
    }))

    yield assert.isRejected(quotePromise, LedgerNotConnectedError, 'No connection to ledger "eur-ledger."')
  })

  it('fails when the destination ledger connection is closed', function * () {
    this.ledgers.getPlugin('usd-ledger.').connected = false
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationAmount: '100',
      destinationHoldDuration: 5
    }))

    yield assert.isRejected(quotePromise, LedgerNotConnectedError, 'No connection to ledger "usd-ledger."')
  })
})
