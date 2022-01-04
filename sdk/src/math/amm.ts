import { BN } from '@project-serum/anchor';
import {
	MARK_PRICE_PRECISION,
	ONE,
	PEG_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import { calculateBaseAssetValue } from './position';
import {
	AMM,
	PositionDirection,
	SwapDirection,
	Market,
	isVariant,
} from '../types';
import { assert } from '../assert/assert';
import {
	calculatePositionPNL,
	calculateMarkPrice,
	convertToNumber,
	squareRootBN,
} from '..';

/**
 * Calculates a price given an arbitrary base and quote amount (they must have the same precision)
 *
 * @param baseAssetAmount
 * @param quoteAssetAmount
 * @param peg_multiplier
 * @returns price : Precision MARK_PRICE_PRECISION
 */
export function calculatePrice(
	baseAssetAmount: BN,
	quoteAssetAmount: BN,
	peg_multiplier: BN
): BN {
	if (baseAssetAmount.abs().lte(ZERO)) {
		return new BN(0);
	}

	return quoteAssetAmount
		.mul(MARK_PRICE_PRECISION)
		.mul(peg_multiplier)
		.div(PEG_PRECISION)
		.div(baseAssetAmount);
}

export type AssetType = 'quote' | 'base';

/**
 * Calculates what the amm reserves would be after swapping a quote or base asset amount.
 *
 * @param amm
 * @param inputAssetType
 * @param swapAmount
 * @param swapDirection
 * @returns quoteAssetReserve and baseAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateAmmReservesAfterSwap(
	amm: AMM,
	inputAssetType: AssetType,
	swapAmount: BN,
	swapDirection: SwapDirection
): [BN, BN] {
	assert(swapAmount.gte(ZERO), 'swapAmount must be greater than 0');

	let newQuoteAssetReserve;
	let newBaseAssetReserve;

	if (inputAssetType === 'quote') {
		const swapAmountIntermediate = swapAmount.mul(MARK_PRICE_PRECISION);
		swapAmount = swapAmountIntermediate.div(amm.pegMultiplier);

		// Because ints round down by default, we need to add 1 back when removing from
		// AMM to avoid giving users extra pnl when they short
		const roundUp =
			swapDirection === SwapDirection.REMOVE &&
			!swapAmountIntermediate.mod(amm.pegMultiplier).eq(ZERO);
		if (roundUp) {
			swapAmount = swapAmount.add(ONE);
		}

		[newQuoteAssetReserve, newBaseAssetReserve] = calculateSwapOutput(
			amm.quoteAssetReserve,
			swapAmount,
			swapDirection,
			amm.sqrtK.mul(amm.sqrtK)
		);
	} else {
		[newBaseAssetReserve, newQuoteAssetReserve] = calculateSwapOutput(
			amm.baseAssetReserve,
			swapAmount,
			swapDirection,
			amm.sqrtK.mul(amm.sqrtK)
		);
	}

	return [newQuoteAssetReserve, newBaseAssetReserve];
}

/**
 * Helper function calculating constant product curve output. Agnostic to whether input asset is quote or base
 *
 * @param inputAssetReserve
 * @param swapAmount
 * @param swapDirection
 * @param invariant
 * @returns newInputAssetReserve and newOutputAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateSwapOutput(
	inputAssetReserve: BN,
	swapAmount: BN,
	swapDirection: SwapDirection,
	invariant: BN
): [BN, BN] {
	let newInputAssetReserve;
	if (swapDirection === SwapDirection.ADD) {
		newInputAssetReserve = inputAssetReserve.add(swapAmount);
	} else {
		newInputAssetReserve = inputAssetReserve.sub(swapAmount);
	}
	const newOutputAssetReserve = invariant.div(newInputAssetReserve);
	return [newInputAssetReserve, newOutputAssetReserve];
}

/**
 * Translate long/shorting quote/base asset into amm operation
 *
 * @param inputAssetType
 * @param positionDirection
 */
export function getSwapDirection(
	inputAssetType: AssetType,
	positionDirection: PositionDirection
): SwapDirection {
	if (isVariant(positionDirection, 'long') && inputAssetType === 'base') {
		return SwapDirection.REMOVE;
	}

	if (isVariant(positionDirection, 'short') && inputAssetType === 'quote') {
		return SwapDirection.REMOVE;
	}

	return SwapDirection.ADD;
}

/**
 * Helper function calculating adjust k cost
 * @param market
 * @param marketIndex
 * @param numerator
 * @param denomenator
 * @returns cost : Precision QUOTE_ASSET_PRECISION
 */
export function calculateAdjustKCost(
	market: Market,
	marketIndex: BN,
	numerator: BN,
	denomenator: BN
): BN {
	const netUserPosition = {
		baseAssetAmount: market.baseAssetAmount,
		lastCumulativeFundingRate: market.amm.cumulativeFundingRate,
		marketIndex: new BN(marketIndex),
		quoteAssetAmount: new BN(0),
		openOrders: new BN(0),
	};

	const currentValue = calculateBaseAssetValue(market, netUserPosition);

	const marketNewK = Object.assign({}, market);
	marketNewK.amm = Object.assign({}, market.amm);

	marketNewK.amm.baseAssetReserve = market.amm.baseAssetReserve
		.mul(numerator)
		.div(denomenator);
	marketNewK.amm.quoteAssetReserve = market.amm.quoteAssetReserve
		.mul(numerator)
		.div(denomenator);
	marketNewK.amm.sqrtK = market.amm.sqrtK.mul(numerator).div(denomenator);

	netUserPosition.quoteAssetAmount = currentValue;

	const cost = calculatePositionPNL(marketNewK, netUserPosition);

	return cost;
}

/**
 * Helper function calculating adjust pegMultiplier (repeg) cost
 *
 * @param market
 * @param marketIndex
 * @param newPeg
 * @returns cost : Precision QUOTE_ASSET_PRECISION
 */
export function calculateRepegCost(
	market: Market,
	marketIndex: BN,
	newPeg: BN
): BN {
	const netUserPosition = {
		baseAssetAmount: market.baseAssetAmount,
		lastCumulativeFundingRate: market.amm.cumulativeFundingRate,
		marketIndex: new BN(marketIndex),
		quoteAssetAmount: new BN(0),
		openOrders: new BN(0),
	};

	const currentValue = calculateBaseAssetValue(market, netUserPosition);
	netUserPosition.quoteAssetAmount = currentValue;
	const prevMarketPrice = calculateMarkPrice(market);
	const marketNewPeg = Object.assign({}, market);
	marketNewPeg.amm = Object.assign({}, market.amm);

	// const marketNewPeg = JSON.parse(JSON.stringify(market));
	marketNewPeg.amm.pegMultiplier = newPeg;

	console.log(
		'Price moves from',
		convertToNumber(prevMarketPrice),
		'to',
		convertToNumber(calculateMarkPrice(marketNewPeg))
	);

	const cost = calculatePositionPNL(marketNewPeg, netUserPosition);

	return cost;
}

/**
 * Helper function calculating terminal price of amm
 *
 * @param market
 * @returns cost : Precision MARK_PRICE_PRECISION
 */
export function calculateTerminalPrice(market: Market) {
	const directionToClose = market.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			market.baseAssetAmount.abs(),
			getSwapDirection('base', directionToClose)
		);
	const terminalPrice = newQuoteAssetReserve
		.mul(MARK_PRICE_PRECISION)
		.mul(market.amm.pegMultiplier)
		.div(PEG_PRECISION)
		.div(newBaseAssetReserve);

	return terminalPrice;
}

export function calculateMaxBaseAssetAmountToTrade(
	amm: AMM,
	limit_price: BN
): [BN, PositionDirection] {
	const invariant = amm.sqrtK.mul(amm.sqrtK);

	const newBaseAssetReserveSquared = invariant
		.mul(MARK_PRICE_PRECISION)
		.mul(amm.pegMultiplier)
		.div(limit_price)
		.div(PEG_PRECISION);

	const newBaseAssetReserve = squareRootBN(newBaseAssetReserveSquared);

	if (newBaseAssetReserve.gt(amm.baseAssetReserve)) {
		return [
			newBaseAssetReserve.sub(amm.baseAssetReserve),
			PositionDirection.SHORT,
		];
	} else if(newBaseAssetReserve.lt(amm.baseAssetReserve)) {
		return [
			amm.baseAssetReserve.sub(newBaseAssetReserve),
			PositionDirection.LONG,
		];
	} else {
		console.log('tradeSize Too Small');
		return [
			new BN(0),
			PositionDirection.LONG,
		];
	}
}
