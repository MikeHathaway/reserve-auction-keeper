// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutor} from "../FlashArbExecutor.sol";
import {Log, TestBase} from "./TestBase.sol";
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

    function test_executeFlashArb_keepsPreExistingAjnaAndEmitsRawQuoteAmount() public {
        router.setNextAmountOut(105 * WAD);
        ajna.mint(address(executor), 7 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: hex"010203",
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
        assertEq(ajna.balanceOf(profitRecipient), 4 * WAD, "profit recipient should receive only trade profit");
    }

    function test_executeFlashArb_repaysWhenAjnaIsToken1() public {
        router.setNextAmountOut(105 * WAD);

        MockUniswapV3Pool token1AjnaPool = MockUniswapV3Pool(
            factory.createPool(address(quote), address(ajna), POOL_FEE, 0, 1 * WAD)
        );
        ajna.mint(address(token1AjnaPool), 200 * WAD);

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(token1AjnaPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 100 * WAD,
            quoteAmount: QUOTE_TOKEN_WAD,
            swapPath: hex"010203",
            minAjnaOut: 104 * WAD,
            profitRecipient: profitRecipient
        });

        executor.executeFlashArb(params);

        assertEq(ajna.balanceOf(address(token1AjnaPool)), 201 * WAD, "token1 flash pool repaid with fee");
        assertEq(quote.balanceOf(address(router)), QUOTE_TOKEN_RAW, "router received raw quote");
        assertEq(ajna.balanceOf(profitRecipient), 4 * WAD, "profit recipient received profit");
    }

    function test_uniswapV3FlashCallback_revertsWhenCallbackWasNotAuthorizedByOwner() public {
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

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.UnauthorizedCallback.selector));
        flashPool.flash(address(executor), 100 * WAD, 0, abi.encode(params));
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

    function test_executeFlashArb_revertsForMalformedFlashPool() public {
        MockMalformedAjnaPool malformedPool = new MockMalformedAjnaPool(
            address(quote),
            QUOTE_TOKEN_SCALE,
            QUOTE_TOKEN_WAD
        );

        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(malformedPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidFlashPool.selector));
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

    function test_executeFlashArb_revertsForZeroProfitRecipient() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: address(0)
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidAddress.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForZeroBorrowAmount() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 0,
            quoteAmount: 1,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidParams.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForZeroQuoteAmount() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 0,
            swapPath: hex"01",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidParams.selector));
        executor.executeFlashArb(params);
    }

    function test_executeFlashArb_revertsForEmptySwapPath() public {
        FlashArbExecutor.ExecuteParams memory params = FlashArbExecutor.ExecuteParams({
            flashPool: address(flashPool),
            ajnaPool: address(ajnaPool),
            borrowAmount: 1,
            quoteAmount: 1,
            swapPath: "",
            minAjnaOut: 1,
            profitRecipient: profitRecipient
        });

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.InvalidParams.selector));
        executor.executeFlashArb(params);
    }

    function test_isCanonicalFactoryPool_returnsFalseForEOA() public view {
        assertTrue(
            !executor.isCanonicalFactoryPool(address(0x1234)),
            "non-contract address should not be treated as canonical pool"
        );
    }

    function test_isCanonicalFactoryPool_returnsFalseForMalformedContract() public {
        MockMalformedAjnaPool malformedPool = new MockMalformedAjnaPool(
            address(quote),
            QUOTE_TOKEN_SCALE,
            QUOTE_TOKEN_WAD
        );

        assertTrue(
            !executor.isCanonicalFactoryPool(address(malformedPool)),
            "malformed contract should not be treated as canonical pool"
        );
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
