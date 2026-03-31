// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutor} from "../FlashArbExecutor.sol";
import {TestBase} from "./TestBase.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAjnaPool} from "./mocks/MockAjnaPool.sol";
import {MockMalformedAjnaPool} from "./mocks/MockMalformedAjnaPool.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./mocks/MockUniswapV3Pool.sol";

contract FlashArbExecutorTest is TestBase {
    uint256 internal constant WAD = 1e18;
    uint24 internal constant POOL_FEE = 3000;
    uint256 internal constant QUOTE_TOKEN_SCALE = 1e12;
    uint256 internal constant QUOTE_TOKEN_RAW = 50 * 1e6;
    uint256 internal constant QUOTE_TOKEN_WAD = QUOTE_TOKEN_RAW * QUOTE_TOKEN_SCALE;

    MockERC20 internal ajna;
    MockERC20 internal quote;
    MockSwapRouter internal router;
    MockAjnaPool internal ajnaPool;
    MockUniswapV3Factory internal factory;
    MockUniswapV3Factory internal rogueFactory;
    MockUniswapV3Pool internal flashPool;
    FlashArbExecutor internal executor;

    address internal profitRecipient = address(0xBEEF);

    function setUp() public {
        ajna = new MockERC20("Ajna", "AJNA");
        quote = new MockERC20("Quote", "QUOTE");
        router = new MockSwapRouter(address(quote), address(ajna));
        factory = new MockUniswapV3Factory();
        rogueFactory = new MockUniswapV3Factory();
        executor = new FlashArbExecutor(
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

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: hex"010203",
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        executor.executeFlashArb(params);

        assertEq(ajna.balanceOf(address(flashPool)), 201 * WAD, "flash pool repaid with fee");
        assertEq(quote.balanceOf(address(router)), QUOTE_TOKEN_RAW, "router received raw quote");
        assertEq(ajna.balanceOf(profitRecipient), 4 * WAD, "profit recipient received profit");
        assertEq(ajna.balanceOf(address(ajnaPool)), 100 * WAD, "ajna pool burned borrowed ajna");
        assertEq(router.lastAmountIn(), QUOTE_TOKEN_RAW, "router swap consumed raw quote amount");
    }

    function test_uniswapV3FlashCallback_revertsForNonPoolCaller() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidFlashPool.selector));
        executor.uniswapV3FlashCallback(0, 0, abi.encode(params));
    }

    function test_executeFlashArb_revertsWhenSwapOutputCannotRepay() public {
        router.setNextAmountOut(100 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: hex"010203",
            minAjnaOut: 100 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InsufficientRepayment.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForUnsupportedBorrowToken() public {
        MockERC20 other = new MockERC20("Other", "OTHER");
        MockUniswapV3Pool badPool = MockUniswapV3Pool(
            rogueFactory.createPool(address(other), address(quote), POOL_FEE, 0, 0)
        );

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(badPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.UnsupportedBorrowToken.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForNonCanonicalFactoryPool() public {
        router.setNextAmountOut(105 * WAD);

        MockUniswapV3Pool roguePool = MockUniswapV3Pool(
            rogueFactory.createPool(address(ajna), address(quote), POOL_FEE, 1 * WAD, 0)
        );
        ajna.mint(address(roguePool), 200 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(roguePool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: hex"010203",
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidFactoryPool.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_onlyOwner() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.prank(address(0xCAFE));
        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.Unauthorized.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForNonIntegralQuoteAmount() public {
        router.setNextAmountOut(105 * WAD);
        MockMalformedAjnaPool malformedPool = new MockMalformedAjnaPool(
            address(quote),
            QUOTE_TOKEN_SCALE,
            QUOTE_TOKEN_WAD + 1
        );

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(malformedPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: hex"010203",
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidQuoteAmount.selector));
        executor.executeFlashArb(params);
    }
}
