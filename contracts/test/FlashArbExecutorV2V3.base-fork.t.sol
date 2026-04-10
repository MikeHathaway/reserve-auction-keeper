// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutorV2V3} from "../FlashArbExecutorV2V3.sol";
import {IAjnaPoolLike, IERC20Like} from "../FlashArbExecutor.sol";
import {TestBase} from "./TestBase.sol";

interface IPoolInfoUtilsLikeBase {
    function poolReservesInfo(
        address pool
    ) external view returns (uint256, uint256, uint256, uint256, uint256);
}

interface IAjnaReservePoolLikeBase is IAjnaPoolLike {
    function kickReserveAuction() external;
}

interface IQuoterV2LikeBase {
    function quoteExactInput(
        bytes memory path,
        uint256 amountIn
    ) external returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

interface IUniswapV2PairLiveLike {
    function factory() external view returns (address);
}

interface IUniswapV3PoolStateLikeBase {
    function liquidity() external view returns (uint128);
}

contract FlashArbExecutorV2V3BaseForkTest is TestBase {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant TARGET_TAKE_QUOTE_TOKEN_RAW = 100_000; // 0.1 USDC
    uint256 internal constant PINNED_FORK_BLOCK_TIMESTAMP = 1775855933;

    address internal constant BASE_UNISWAP_V3_QUOTER =
        0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address internal constant BASE_UNISWAP_V3_ROUTER =
        0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant BASE_WETH_BWAJNA_V2_PAIR =
        0x88c6bc91260585DB77F05B6C59050f252fc7fD8A;
    address internal constant BASE_USDC_BWAJNA_100_POOL =
        0x22698579B63E6d64B629Af7e8C8caa7d449e6970;
    address internal constant BASE_BWAJNA =
        0xf0f326af3b1Ed943ab95C29470730CC8Cf66ae47;
    address internal constant BASE_USDC =
        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_POOL_INFO_UTILS =
        0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa;

    function test_basePinnedForkV2V3VenuesAreLiveButNoExecutableReserveAuctionPathExists() public {
        vm.warp(PINNED_FORK_BLOCK_TIMESTAMP);

        IAjnaReservePoolLikeBase reservePool = _selectKickableUsdcReservePool();
        address flashPairFactory = IUniswapV2PairLiveLike(BASE_WETH_BWAJNA_V2_PAIR).factory();
        FlashArbExecutorV2V3 executor = new FlashArbExecutorV2V3(
            BASE_BWAJNA,
            BASE_UNISWAP_V3_ROUTER,
            flashPairFactory
        );

        assertEq(
            reservePool.quoteTokenAddress(),
            BASE_USDC,
            "fixture should be a pinned Base USDC reserve-auction pool"
        );

        assertTrue(
            IERC20Like(BASE_BWAJNA).balanceOf(BASE_WETH_BWAJNA_V2_PAIR) > 0,
            "pinned V2 flash source should have AJNA liquidity"
        );
        assertTrue(
            IUniswapV3PoolStateLikeBase(BASE_USDC_BWAJNA_100_POOL).liquidity() > 0,
            "pinned direct V3 USDC/AJNA pool should have live liquidity"
        );
        (uint256 quotedAjnaOut, , , ) = IQuoterV2LikeBase(BASE_UNISWAP_V3_QUOTER).quoteExactInput(
            _baseDirectUsdcToAjnaPath(),
            TARGET_TAKE_QUOTE_TOKEN_RAW
        );
        assertTrue(quotedAjnaOut > 0, "direct Base USDC->AJNA path should remain quoteable");

        bool executed = _tryExecutePinnedV2V3FlashArb(reservePool, executor);
        assertTrue(!executed, "expected no executable base v2->v3 reserve-auction path on the pinned fork");
    }

    function _selectKickableUsdcReservePool() internal returns (IAjnaReservePoolLikeBase) {
        address[8] memory candidatePools = [
            address(0x0B17159F2486f669a1F930926638008E2ccB4287),
            address(0xB156f09E8ab6756Cd23Cf283D495ab75f8334104),
            address(0x52e69a7cf5076a769E11FfFc2e99E837B575F65e),
            address(0x97dBbDBa28DF6d629bc17e0349Bcb73D541Ed041),
            address(0x6B2040A7271b1bF8ceC3978df31579Eb59eB8b7F),
            address(0x40ed817Ae602d8Dad1103576A9162810b0B01FB1),
            address(0x907fC8E161c15a1cE377f7ef91FA6A5983ED1e78),
            address(0x1AbC629d901100218CdfD389e6e778b9399e9f70)
        ];

        for (uint256 i = 0; i < candidatePools.length; ++i) {
            IAjnaReservePoolLikeBase candidatePool = IAjnaReservePoolLikeBase(candidatePools[i]);
            if (candidatePool.quoteTokenAddress() != BASE_USDC) continue;

            try candidatePool.kickReserveAuction() {
                return candidatePool;
            } catch {}
        }

        revert("no kickable pinned Base USDC reserve-auction pool found");
    }

    function _tryExecutePinnedV2V3FlashArb(
        IAjnaReservePoolLikeBase reservePool,
        FlashArbExecutorV2V3 executor
    ) internal returns (bool) {
        IPoolInfoUtilsLikeBase poolInfoUtils = IPoolInfoUtilsLikeBase(BASE_POOL_INFO_UTILS);
        uint256 quoteTokenScale = reservePool.quoteTokenScale();
        (, , uint256 claimableAfterKick, , uint256 timeRemainingAfterKick) =
            poolInfoUtils.poolReservesInfo(address(reservePool));
        uint256 availableRawQuote = claimableAfterKick / quoteTokenScale;
        uint256 takeQuoteTokenRaw =
            availableRawQuote < TARGET_TAKE_QUOTE_TOKEN_RAW
                ? availableRawQuote
                : TARGET_TAKE_QUOTE_TOKEN_RAW;
        assertTrue(takeQuoteTokenRaw > 0, "pinned reserve auction should have claimable USDC");
        assertTrue(
            timeRemainingAfterKick > 1,
            "kicked reserve auction should still have time remaining"
        );

        vm.warp(PINNED_FORK_BLOCK_TIMESTAMP + timeRemainingAfterKick - 1);

        (, , , uint256 auctionPrice, uint256 timeRemainingNearExpiry) =
            poolInfoUtils.poolReservesInfo(address(reservePool));
        assertTrue(timeRemainingNearExpiry > 0, "auction should still be live near expiry");

        assertTrue(
            IERC20Like(BASE_BWAJNA).balanceOf(BASE_WETH_BWAJNA_V2_PAIR) > 0,
            "pinned flash source should have AJNA liquidity"
        );
        assertTrue(
            IERC20Like(BASE_BWAJNA).balanceOf(BASE_USDC_BWAJNA_100_POOL) > 0,
            "pinned V3 swap venue should have AJNA liquidity"
        );

        while (takeQuoteTokenRaw > 0) {
            try executor.executeFlashArb(
                _buildPinnedV2V3Params(
                    address(reservePool),
                    takeQuoteTokenRaw * quoteTokenScale,
                    auctionPrice
                )
            ) {
                return true;
            } catch {
                takeQuoteTokenRaw /= 2;
            }
        }

        return false;
    }

    function _buildPinnedV2V3Params(
        address reservePool,
        uint256 takeAmount,
        uint256 auctionPrice
    ) internal view returns (FlashArbExecutorV2V3.ExecuteParams memory params) {
        params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: BASE_WETH_BWAJNA_V2_PAIR,
            ajnaPool: reservePool,
            borrowAmount: _ceilWadMul(takeAmount, auctionPrice),
            quoteAmount: takeAmount,
            swapPath: _baseDirectUsdcToAjnaPath(),
            minAjnaOut: 0,
            profitRecipient: address(this)
        });
    }

    function _baseDirectUsdcToAjnaPath() internal pure returns (bytes memory) {
        return abi.encodePacked(BASE_USDC, uint24(100), BASE_BWAJNA);
    }

    function _ceilWadMul(uint256 left, uint256 right) internal pure returns (uint256) {
        if (left == 0 || right == 0) return 0;
        return (left * right + WAD - 1) / WAD;
    }
}
