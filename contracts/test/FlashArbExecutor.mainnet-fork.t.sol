// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutor} from "../FlashArbExecutor.sol";
import {IAjnaPoolLike, IERC20Like} from "../FlashArbExecutorBase.sol";
import {FlashArbExecutorV3V2} from "../FlashArbExecutorV3V2.sol";
import {TestBase} from "./TestBase.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3Pool.sol";

interface IUniswapV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3PoolStateLike {
    function liquidity() external view returns (uint128);
    function fee() external view returns (uint24);
}

interface IQuoterV2Like {
    function quoteExactInput(
        bytes memory path,
        uint256 amountIn
    ) external returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

interface IPoolInfoUtilsLike {
    function poolReservesInfo(
        address pool
    ) external view returns (uint256, uint256, uint256, uint256, uint256);
}

interface IAjnaReservePoolLike is IAjnaPoolLike {
    function kickReserveAuction() external;
}

contract FlashArbExecutorMainnetForkTest is TestBase {
    struct PinnedFlashArbConfig {
        uint256 takeAmount;
        uint256 takeQuoteTokenRaw;
        uint256 borrowAmount;
        uint256 repayAmount;
        bytes path;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant UNISWAP_FEE_DENOMINATOR = 1_000_000;
    uint256 internal constant TARGET_TAKE_QUOTE_TOKEN_RAW = 1_000_000; // 1 USDC
    uint256 internal constant PINNED_FORK_BLOCK_TIMESTAMP = 1774916723;

    address internal constant MAINNET_UNISWAP_V3_FACTORY =
        0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address internal constant MAINNET_UNISWAP_V3_ROUTER =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address internal constant MAINNET_UNISWAP_V2_ROUTER =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant MAINNET_UNISWAP_V3_QUOTER =
        0x61fFE014bA17989E743c5F6cB21bF9697530B21e;
    bytes32 internal constant MAINNET_UNISWAP_V3_POOL_INIT_CODE_HASH =
        0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    address internal constant MAINNET_USDC_WETH_3000_POOL =
        0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8;
    address internal constant MAINNET_AJNA_WETH_10000_POOL =
        0xB79323DDEd09EaBAE6366cE11c51EC53b3fcd57e;
    address internal constant MAINNET_AJNA =
        0x9a96ec9B57Fb64FbC60B423d1f4da7691Bd35079;
    address internal constant MAINNET_WETH =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant MAINNET_USDC =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant MAINNET_POOL_INFO_UTILS =
        0x30c5eF2997d6a882DE52c4ec01B6D0a5e5B4fAAE;

    function test_mainnetCanonicalPoolVerificationMatchesRealUniswapPool() public {
        FlashArbExecutor executor = new FlashArbExecutor(
            MAINNET_AJNA,
            address(0x1111111111111111111111111111111111111111),
            MAINNET_UNISWAP_V3_FACTORY,
            MAINNET_UNISWAP_V3_POOL_INIT_CODE_HASH
        );

        assertTrue(
            executor.isCanonicalFactoryPool(MAINNET_USDC_WETH_3000_POOL),
            "known mainnet Uniswap V3 pool should validate against factory + init code hash"
        );
    }

    function test_mainnetCanonicalPoolVerificationRejectsRogueFactoryPool() public {
        MockUniswapV3Factory rogueFactory = new MockUniswapV3Factory();
        MockUniswapV3Pool roguePool = MockUniswapV3Pool(
            rogueFactory.createPool(
                MAINNET_AJNA,
                0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,
                3000,
                0,
                0
            )
        );

        FlashArbExecutor executor = new FlashArbExecutor(
            MAINNET_AJNA,
            address(0x1111111111111111111111111111111111111111),
            MAINNET_UNISWAP_V3_FACTORY,
            MAINNET_UNISWAP_V3_POOL_INIT_CODE_HASH
        );

        assertTrue(
            !executor.isCanonicalFactoryPool(address(roguePool)),
            "pool deployed from rogue factory must fail canonical verification"
        );
    }

    function test_mainnetPinnedForkFlashArbRouteReusesLockedFlashPool() public {
        vm.warp(PINNED_FORK_BLOCK_TIMESTAMP);

        IAjnaReservePoolLike reservePool = _selectKickableUsdcReservePool();

        FlashArbExecutor executor = new FlashArbExecutor(
            MAINNET_AJNA,
            MAINNET_UNISWAP_V3_ROUTER,
            MAINNET_UNISWAP_V3_FACTORY,
            MAINNET_UNISWAP_V3_POOL_INIT_CODE_HASH
        );
        assertEq(
            reservePool.quoteTokenAddress(),
            MAINNET_USDC,
            "fixture should be the pinned USDC reserve-auction pool"
        );
        _assertPinnedUsdcRouteTopology();

        PinnedFlashArbConfig memory config = _preparePinnedFlashArbConfig(reservePool);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: MAINNET_AJNA_WETH_10000_POOL,
            ajnaPool: address(reservePool),
            borrowAmount: config.borrowAmount,
            quoteAmount: config.takeAmount,
            swapPath: config.path,
            minAjnaOut: 0,
            profitRecipient: address(this)
        });

        vm.expectRevert(
            abi.encodeWithSelector(FlashArbExecutor.FlashPoolReuseInSwapPath.selector)
        );
        executor.executeFlashArb(params);
    }

    function test_mainnetPinnedForkV3V2FlashArbExecutesThroughDistinctV2SwapRoute() public {
        vm.warp(PINNED_FORK_BLOCK_TIMESTAMP);

        IAjnaReservePoolLike reservePool = _selectKickableUsdcReservePool();
        FlashArbExecutorV3V2 executor = new FlashArbExecutorV3V2(
            MAINNET_AJNA,
            MAINNET_UNISWAP_V2_ROUTER,
            MAINNET_UNISWAP_V3_FACTORY,
            MAINNET_UNISWAP_V3_POOL_INIT_CODE_HASH
        );

        assertEq(
            reservePool.quoteTokenAddress(),
            MAINNET_USDC,
            "fixture should be the pinned USDC reserve-auction pool"
        );

        uint256 flashPoolAjnaBefore = IERC20Like(MAINNET_AJNA).balanceOf(MAINNET_AJNA_WETH_10000_POOL);
        uint256 profitRecipientBefore = IERC20Like(MAINNET_AJNA).balanceOf(address(this));

        bool executed = _tryExecutePinnedV3V2FlashArb(reservePool, executor);
        assertTrue(executed, "expected at least one executable v3->v2 flash-arb configuration");
        assertTrue(
            IERC20Like(MAINNET_AJNA).balanceOf(MAINNET_AJNA_WETH_10000_POOL) > flashPoolAjnaBefore,
            "flash pool should accrue AJNA fee"
        );
        assertTrue(
            IERC20Like(MAINNET_AJNA).balanceOf(address(this)) > profitRecipientBefore,
            "profit recipient should receive AJNA profit"
        );
    }

    function _assertPinnedUsdcRouteTopology() internal view {
        IUniswapV3FactoryLike factory = IUniswapV3FactoryLike(MAINNET_UNISWAP_V3_FACTORY);
        address ajnaWethPool = factory.getPool(MAINNET_AJNA, MAINNET_WETH, 10_000);
        address ajnaUsdc3000Pool = factory.getPool(MAINNET_AJNA, MAINNET_USDC, 3_000);
        address ajnaUsdc10000Pool = factory.getPool(MAINNET_AJNA, MAINNET_USDC, 10_000);

        assertEq(
            ajnaWethPool,
            MAINNET_AJNA_WETH_10000_POOL,
            "expected pinned AJNA/WETH flash pool should exist"
        );
        assertTrue(
            ajnaUsdc3000Pool != address(0) && ajnaUsdc10000Pool != address(0),
            "expected pinned direct USDC/AJNA pools should exist"
        );
        assertEq(
            IUniswapV3PoolStateLike(ajnaUsdc3000Pool).liquidity(),
            0,
            "direct USDC/AJNA 0.3% pool should be inactive on the pinned fork"
        );
        assertEq(
            IUniswapV3PoolStateLike(ajnaUsdc10000Pool).liquidity(),
            0,
            "direct USDC/AJNA 1% pool should be inactive on the pinned fork"
        );
    }

    function _preparePinnedFlashArbConfig(
        IAjnaReservePoolLike reservePool
    ) internal returns (PinnedFlashArbConfig memory config) {
        IPoolInfoUtilsLike poolInfoUtils = IPoolInfoUtilsLike(MAINNET_POOL_INFO_UTILS);
        IQuoterV2Like quoter = IQuoterV2Like(MAINNET_UNISWAP_V3_QUOTER);

        uint256 quoteTokenScale = reservePool.quoteTokenScale();
        (, , uint256 claimableAfterKick, , uint256 timeRemainingAfterKick) =
            poolInfoUtils.poolReservesInfo(address(reservePool));
        uint256 availableRawQuote = claimableAfterKick / quoteTokenScale;
        config.takeQuoteTokenRaw =
            availableRawQuote < TARGET_TAKE_QUOTE_TOKEN_RAW
                ? availableRawQuote
                : TARGET_TAKE_QUOTE_TOKEN_RAW;
        config.takeAmount = config.takeQuoteTokenRaw * quoteTokenScale;
        assertTrue(config.takeAmount > 0, "pinned reserve auction should have claimable USDC");
        assertTrue(
            timeRemainingAfterKick > 1,
            "kicked reserve auction should still have time remaining"
        );

        vm.warp(PINNED_FORK_BLOCK_TIMESTAMP + timeRemainingAfterKick - 1);

        config.path = abi.encodePacked(
            MAINNET_USDC,
            uint24(3_000),
            MAINNET_WETH,
            uint24(10_000),
            MAINNET_AJNA
        );
        (uint256 quotedAjnaOut, , , ) = quoter.quoteExactInput(
            config.path,
            config.takeQuoteTokenRaw
        );
        assertTrue(
            quotedAjnaOut > 0,
            "the pinned fork should still have a live quoted USDC->WETH->AJNA route"
        );

        (, , , uint256 auctionPrice, uint256 timeRemainingNearExpiry) =
            poolInfoUtils.poolReservesInfo(address(reservePool));
        assertTrue(timeRemainingNearExpiry > 0, "auction should still be live near expiry");

        config.borrowAmount = _ceilWadMul(config.takeAmount, auctionPrice);
        config.repayAmount = config.borrowAmount + _calculateFlashFee(
            config.borrowAmount,
            IUniswapV3PoolStateLike(MAINNET_AJNA_WETH_10000_POOL).fee()
        );
        assertTrue(
            quotedAjnaOut > config.repayAmount,
            "near expiry the live route should cover repayment before the pool-lock constraint"
        );
    }

    function _selectKickableUsdcReservePool() internal returns (IAjnaReservePoolLike) {
        address[10] memory candidatePools = [
            address(0x9cdB48FcBd8241Bb75887AF04d3b1302c410F671),
            address(0xE4BfB9b344A0Ae89702184281F13A295F3D49e15),
            address(0x2Ceb74Bb7a92D652C850C16F48547aa49F8bca31),
            address(0x3BA6A019eD5541b5F5555d8593080042Cf3ae5f4),
            address(0xE300B3A6b24cB3c5c87034155F7ffF7F77C862a0),
            address(0x66ea46C6e7F9e5BB065bd3B1090FFF229393BA51),
            address(0xc8f9750cDc473a17559225A8C958d229aD0D9c04),
            address(0xfe33ecd5758A34e4a3D0E9F746aec428B7638E78),
            address(0x2fEeF99A711D684E00a017C4AC587bea31F12875),
            address(0x304375E4890146DC575B894b35a42608FaB823a8)
        ];

        for (uint256 i = 0; i < candidatePools.length; ++i) {
            IAjnaReservePoolLike candidatePool = IAjnaReservePoolLike(candidatePools[i]);
            if (candidatePool.quoteTokenAddress() != MAINNET_USDC) continue;

            try candidatePool.kickReserveAuction() {
                return candidatePool;
            } catch {}
        }

        revert("no kickable pinned USDC reserve-auction pool found");
    }

    function _tryExecutePinnedV3V2FlashArb(
        IAjnaReservePoolLike reservePool,
        FlashArbExecutorV3V2 executor
    ) internal returns (bool) {
        IPoolInfoUtilsLike poolInfoUtils = IPoolInfoUtilsLike(MAINNET_POOL_INFO_UTILS);
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

        while (takeQuoteTokenRaw > 0) {
            try executor.executeFlashArb(
                _buildPinnedV3V2Params(
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

    function _buildPinnedV3V2Params(
        address reservePool,
        uint256 takeAmount,
        uint256 auctionPrice
    ) internal view returns (FlashArbExecutorV3V2.ExecuteParams memory params) {
        params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: MAINNET_AJNA_WETH_10000_POOL,
            ajnaPool: reservePool,
            borrowAmount: _ceilWadMul(takeAmount, auctionPrice),
            quoteAmount: takeAmount,
            swapPath: _mainnetV2SwapPath(),
            minAjnaOut: 0,
            profitRecipient: address(this)
        });
    }

    function _mainnetV2SwapPath() internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = MAINNET_USDC;
        path[1] = MAINNET_WETH;
        path[2] = MAINNET_AJNA;
    }

    function _ceilWadMul(uint256 left, uint256 right) internal pure returns (uint256) {
        if (left == 0 || right == 0) return 0;
        return (left * right + WAD - 1) / WAD;
    }

    function _calculateFlashFee(uint256 borrowAmount, uint24 feePpm) internal pure returns (uint256) {
        return (borrowAmount * feePpm + UNISWAP_FEE_DENOMINATOR - 1) /
            UNISWAP_FEE_DENOMINATOR;
    }
}
