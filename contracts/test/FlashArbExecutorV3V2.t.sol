// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutorV3V2} from "../FlashArbExecutorV3V2.sol";
import {Log, TestBase} from "./TestBase.sol";
import {MockAjnaPool} from "./mocks/MockAjnaPool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockMalformedAjnaPool} from "./mocks/MockMalformedAjnaPool.sol";
import {MockUniswapV2Router} from "./mocks/MockUniswapV2Router.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3Pool.sol";

contract FlashArbExecutorV3V2Test is TestBase {
    uint256 internal constant WAD = 1e18;
    uint24 internal constant POOL_FEE = 3000;
    uint256 internal constant QUOTE_TOKEN_SCALE = 1e12;
    uint256 internal constant QUOTE_TOKEN_RAW = 50 * 1e6;
    uint256 internal constant QUOTE_TOKEN_WAD = QUOTE_TOKEN_RAW * QUOTE_TOKEN_SCALE;

    MockERC20 internal ajna;
    MockERC20 internal quote;
    MockUniswapV2Router internal router;
    MockAjnaPool internal ajnaPool;
    MockUniswapV3Factory internal factory;
    MockUniswapV3Factory internal rogueFactory;
    MockUniswapV3Pool internal flashPool;
    FlashArbExecutorV3V2 internal executor;

    address internal profitRecipient = address(0xBEEF);

    function _swapPath() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(quote);
        path[1] = address(ajna);
    }

    function setUp() public {
        ajna = new MockERC20("Ajna", "AJNA");
        quote = new MockERC20("Quote", "QUOTE");
        router = new MockUniswapV2Router(address(quote), address(ajna));
        factory = new MockUniswapV3Factory();
        rogueFactory = new MockUniswapV3Factory();
        executor = new FlashArbExecutorV3V2(
            address(ajna),
            address(router),
            address(factory),
            keccak256(type(MockUniswapV3Pool).creationCode)
        );
        ajnaPool = new MockAjnaPool(address(ajna), address(quote), QUOTE_TOKEN_SCALE, 2 * WAD);
        flashPool = MockUniswapV3Pool(
            factory.createPool(address(ajna), address(quote), POOL_FEE, 1 * WAD, 0)
        );

        ajna.mint(address(flashPool), 200 * WAD);
        quote.mint(address(ajnaPool), QUOTE_TOKEN_RAW);
        ajna.mint(address(router), 105 * WAD);
    }

    function test_executeFlashArb_repaysFlashLoanAndTransfersProfit() public {
        router.setNextAmountOut(105 * WAD);

        FlashArbExecutorV3V2.ExecuteParams memory params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        executor.executeFlashArb(params);

        assertEq(ajna.balanceOf(address(flashPool)), 201 * WAD, "flash pool repaid with fee");
        assertEq(quote.balanceOf(address(router)), QUOTE_TOKEN_RAW, "router received raw quote");
        assertEq(ajna.balanceOf(profitRecipient), 4 * WAD, "profit recipient received profit");
    }

    function test_executeFlashArb_keepsPreExistingAjnaAndEmitsRawQuoteAmount() public {
        router.setNextAmountOut(105 * WAD);
        ajna.mint(address(executor), 7 * WAD);

        FlashArbExecutorV3V2.ExecuteParams memory params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.recordLogs();
        executor.executeFlashArb(params);

        Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "should emit a single flash-arb event");

        (uint256 quoteTokenAmount, uint256 borrowedAjna, uint256 repaidAjna, uint256 profitAjna) =
            abi.decode(logs[0].data, (uint256, uint256, uint256, uint256));

        assertEq(quoteTokenAmount, QUOTE_TOKEN_RAW, "event should emit raw quote token units");
        assertEq(borrowedAjna, 100 * WAD, "event should emit borrowed ajna");
        assertEq(repaidAjna, 101 * WAD, "event should emit repaid ajna");
        assertEq(profitAjna, 4 * WAD, "event should emit only trade profit");
        assertEq(ajna.balanceOf(address(executor)), 7 * WAD, "pre-existing ajna should remain in executor");
    }

    function test_uniswapV3FlashCallback_revertsForNonPoolCaller() public {
        FlashArbExecutorV3V2.ExecuteParams memory params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: _swapPath(),
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorV3V2.UnauthorizedCallback.selector));
        executor.uniswapV3FlashCallback(0, 0, abi.encode(params));
    }

    function test_executeFlashArb_revertsForNonCanonicalFactoryPool() public {
        router.setNextAmountOut(105 * WAD);

        MockUniswapV3Pool roguePool = MockUniswapV3Pool(
            rogueFactory.createPool(address(ajna), address(quote), POOL_FEE, 1 * WAD, 0)
        );
        ajna.mint(address(roguePool), 200 * WAD);

        FlashArbExecutorV3V2.ExecuteParams memory params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: address(roguePool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: _swapPath(),
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorV3V2.InvalidFactoryPool.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsWhenSwapPathDoesNotStartWithQuoteToken() public {
        router.setNextAmountOut(105 * WAD);
        address[] memory invalidPath = new address[](2);
        invalidPath[0] = address(ajna);
        invalidPath[1] = address(quote);

        FlashArbExecutorV3V2.ExecuteParams memory params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: invalidPath,
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorV3V2.InvalidSwapPath.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_onlyOwner() public {
        FlashArbExecutorV3V2.ExecuteParams memory params = FlashArbExecutorV3V2.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: _swapPath(),
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.prank(address(0xCAFE));
        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutorV3V2.Unauthorized.selector));
        executor.executeFlashArb(params);
    }
}
