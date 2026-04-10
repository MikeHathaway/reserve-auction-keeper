// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FlashArbExecutorV2V3} from "../FlashArbExecutorV2V3.sol";
import {InvariantBase, FuzzSelector} from "./InvariantBase.sol";
import {MockAjnaPool} from "./mocks/MockAjnaPool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {MockUniswapV2Factory} from "./mocks/MockUniswapV2Factory.sol";
import {MockUniswapV2Pair} from "./mocks/MockUniswapV2Pair.sol";

contract UnauthorizedFlashArbActorV2V3 {
    function tryUnauthorizedExecute(
        FlashArbExecutorV2V3 executor,
        FlashArbExecutorV2V3.ExecuteParams memory params
    ) external returns (bool) {
        try executor.executeFlashArb(params) {
            return true;
        } catch {
            return false;
        }
    }

    function tryUnauthorizedPairCallback(
        MockUniswapV2Pair flashPair,
        address recipient,
        uint256 amount0Out,
        uint256 amount1Out,
        bytes memory data
    ) external returns (bool) {
        try flashPair.swap(amount0Out, amount1Out, recipient, data) {
            return true;
        } catch {
            return false;
        }
    }

    function tryUnauthorizedDirectCallback(
        FlashArbExecutorV2V3 executor,
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes memory data
    ) external returns (bool) {
        try executor.uniswapV2Call(sender, amount0, amount1, data) {
            return true;
        } catch {
            return false;
        }
    }
}

contract FlashArbExecutorV2V3Handler {
    uint256 internal constant WAD = 1e18;
    uint24 internal constant SWAP_PATH_FEE = 500;
    uint256 internal constant MAX_NORMALIZED_QUOTE = 5_000 * WAD;
    uint256 internal constant MAX_PROFIT = 25 * WAD;
    uint256 internal constant MAX_PRESEEDED = 25 * WAD;

    MockERC20 internal ajna;
    MockERC20 internal quote;
    MockSwapRouter internal router;
    MockAjnaPool internal ajnaPool;
    MockUniswapV2Factory internal factory;
    MockUniswapV2Pair internal flashPair;
    FlashArbExecutorV2V3 internal executor;
    UnauthorizedFlashArbActorV2V3 internal attacker;

    address internal constant PROFIT_RECIPIENT = address(0xBEEF);

    uint256 internal immutable quoteTokenScale;
    bool internal immutable ajnaIsToken0;

    uint256 internal expectedProfitRecipientBalance;
    uint256 internal expectedExecutorResidualBalance;
    uint256 internal expectedFlashPairBalance;

    struct StateSnapshot {
        uint256 executorAjna;
        uint256 executorQuote;
        uint256 flashPairAjna;
        uint256 flashPairQuote;
        uint256 routerAjna;
        uint256 routerQuote;
        uint256 ajnaPoolAjna;
        uint256 ajnaPoolQuote;
        uint256 profitRecipientAjna;
    }

    constructor(uint256 quoteTokenScale_, bool ajnaIsToken0_) {
        quoteTokenScale = quoteTokenScale_;
        ajnaIsToken0 = ajnaIsToken0_;

        if (ajnaIsToken0_) {
            ajna = new MockERC20("Ajna", "AJNA");
            quote = new MockERC20("Quote", "QUOTE");
        } else {
            quote = new MockERC20("Quote", "QUOTE");
            ajna = new MockERC20("Ajna", "AJNA");
        }

        router = new MockSwapRouter(address(quote), address(ajna));
        factory = new MockUniswapV2Factory();
        attacker = new UnauthorizedFlashArbActorV2V3();
        executor = new FlashArbExecutorV2V3(address(ajna), address(router), address(factory));
        ajnaPool = new MockAjnaPool(address(ajna), address(quote), quoteTokenScale, 2 * WAD);
        flashPair = MockUniswapV2Pair(factory.createPair(address(ajna), address(quote)));

        ajna.mint(address(flashPair), 1_000_000_000 * WAD);
        quote.mint(address(ajnaPool), 1_000_000_000 * WAD);
        ajna.mint(address(router), 1_000_000_000 * WAD);

        expectedFlashPairBalance = ajna.balanceOf(address(flashPair));
    }

    function executeScenario(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed,
        uint96 preseededAjnaSeed
    ) external {
        uint256 quoteAmount = _normalizedQuoteAmount(normalizedQuoteSeed);
        uint256 borrowAmount = 2 * quoteAmount;
        uint256 profitAmount = _bound(profitSeed, 1, MAX_PROFIT);
        uint256 preseededAjna = _bound(preseededAjnaSeed, 0, MAX_PRESEEDED);

        if (preseededAjna > 0) {
            ajna.mint(address(executor), preseededAjna);
            expectedExecutorResidualBalance += preseededAjna;
        }

        router.setNextAmountOut(_repayAmount(borrowAmount) + profitAmount);

        FlashArbExecutorV2V3.ExecuteParams memory params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(flashPair),
            ajnaPool: address(ajnaPool),
            borrowAmount: borrowAmount,
            quoteAmount: quoteAmount,
            swapPath: _swapPath(),
            minAjnaOut: _repayAmount(borrowAmount) + profitAmount,
            profitRecipient: PROFIT_RECIPIENT
        });

        executor.executeFlashArb(params);

        expectedProfitRecipientBalance += profitAmount;
        expectedFlashPairBalance += _repayAmount(borrowAmount) - borrowAmount;
    }

    function attemptUnauthorizedExecute(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed
    ) external {
        FlashArbExecutorV2V3.ExecuteParams memory params = _buildParams(
            normalizedQuoteSeed,
            profitSeed
        );
        router.setNextAmountOut(params.minAjnaOut);
        StateSnapshot memory before = _snapshotState();
        bool success = attacker.tryUnauthorizedExecute(executor, params);
        require(!success, "unauthorized execute succeeded");
        _assertSnapshotUnchanged(before);
    }

    function attemptUnauthorizedPairCallback(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed
    ) external {
        FlashArbExecutorV2V3.ExecuteParams memory params = _buildParams(
            normalizedQuoteSeed,
            profitSeed
        );
        router.setNextAmountOut(params.minAjnaOut);
        StateSnapshot memory before = _snapshotState();
        (uint256 amount0Out, uint256 amount1Out) = _flashAmounts(params.borrowAmount);
        bool success = attacker.tryUnauthorizedPairCallback(
            flashPair,
            address(executor),
            amount0Out,
            amount1Out,
            abi.encode(params)
        );
        require(!success, "unauthorized pair callback succeeded");
        _assertSnapshotUnchanged(before);
    }

    function attemptUnauthorizedDirectCallback(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed
    ) external {
        FlashArbExecutorV2V3.ExecuteParams memory params = _buildParams(
            normalizedQuoteSeed,
            profitSeed
        );
        router.setNextAmountOut(params.minAjnaOut);
        StateSnapshot memory before = _snapshotState();
        (uint256 amount0Out, uint256 amount1Out) = _flashAmounts(params.borrowAmount);
        bool success = attacker.tryUnauthorizedDirectCallback(
            executor,
            address(executor),
            amount0Out,
            amount1Out,
            abi.encode(params)
        );
        require(!success, "unauthorized direct callback succeeded");
        _assertSnapshotUnchanged(before);
    }

    function profitRecipientBalance() external view returns (uint256) {
        return ajna.balanceOf(PROFIT_RECIPIENT);
    }

    function expectedProfitBalance() external view returns (uint256) {
        return expectedProfitRecipientBalance;
    }

    function executorResidualBalance() external view returns (uint256) {
        return ajna.balanceOf(address(executor));
    }

    function executorQuoteBalance() external view returns (uint256) {
        return quote.balanceOf(address(executor));
    }

    function expectedExecutorResidual() external view returns (uint256) {
        return expectedExecutorResidualBalance;
    }

    function flashPairBalance() external view returns (uint256) {
        return ajna.balanceOf(address(flashPair));
    }

    function expectedFlashPairAjnaBalance() external view returns (uint256) {
        return expectedFlashPairBalance;
    }

    function _buildParams(
        uint96 normalizedQuoteSeed,
        uint96 profitSeed
    ) internal view returns (FlashArbExecutorV2V3.ExecuteParams memory params) {
        uint256 quoteAmount = _normalizedQuoteAmount(normalizedQuoteSeed);
        uint256 borrowAmount = 2 * quoteAmount;
        uint256 profitAmount = _bound(profitSeed, 1, MAX_PROFIT);

        params = FlashArbExecutorV2V3.ExecuteParams({
            flashPair: address(flashPair),
            ajnaPool: address(ajnaPool),
            borrowAmount: borrowAmount,
            quoteAmount: quoteAmount,
            swapPath: _swapPath(),
            minAjnaOut: _repayAmount(borrowAmount) + profitAmount,
            profitRecipient: PROFIT_RECIPIENT
        });
    }

    function _normalizedQuoteAmount(uint96 normalizedQuoteSeed) internal view returns (uint256 quoteAmount) {
        quoteAmount = _bound(normalizedQuoteSeed, quoteTokenScale, MAX_NORMALIZED_QUOTE);
        quoteAmount -= quoteAmount % quoteTokenScale;
        if (quoteAmount == 0) {
            quoteAmount = quoteTokenScale;
        }
    }

    function _swapPath() internal view returns (bytes memory) {
        return abi.encodePacked(address(quote), SWAP_PATH_FEE, address(ajna));
    }

    function _flashAmounts(uint256 borrowAmount) internal view returns (uint256 amount0Out, uint256 amount1Out) {
        if (ajnaIsToken0) {
            amount0Out = borrowAmount;
        } else {
            amount1Out = borrowAmount;
        }
    }

    function _repayAmount(uint256 borrowAmount) internal pure returns (uint256) {
        return (borrowAmount * 1000 + 996) / 997;
    }

    function _snapshotState() internal view returns (StateSnapshot memory snapshot) {
        snapshot = StateSnapshot({
            executorAjna: ajna.balanceOf(address(executor)),
            executorQuote: quote.balanceOf(address(executor)),
            flashPairAjna: ajna.balanceOf(address(flashPair)),
            flashPairQuote: quote.balanceOf(address(flashPair)),
            routerAjna: ajna.balanceOf(address(router)),
            routerQuote: quote.balanceOf(address(router)),
            ajnaPoolAjna: ajna.balanceOf(address(ajnaPool)),
            ajnaPoolQuote: quote.balanceOf(address(ajnaPool)),
            profitRecipientAjna: ajna.balanceOf(PROFIT_RECIPIENT)
        });
    }

    function _assertSnapshotUnchanged(StateSnapshot memory before) internal view {
        require(ajna.balanceOf(address(executor)) == before.executorAjna, "executor ajna changed");
        require(quote.balanceOf(address(executor)) == before.executorQuote, "executor quote changed");
        require(ajna.balanceOf(address(flashPair)) == before.flashPairAjna, "flash pair ajna changed");
        require(quote.balanceOf(address(flashPair)) == before.flashPairQuote, "flash pair quote changed");
        require(ajna.balanceOf(address(router)) == before.routerAjna, "router ajna changed");
        require(quote.balanceOf(address(router)) == before.routerQuote, "router quote changed");
        require(ajna.balanceOf(address(ajnaPool)) == before.ajnaPoolAjna, "ajna pool ajna changed");
        require(quote.balanceOf(address(ajnaPool)) == before.ajnaPoolQuote, "ajna pool quote changed");
        require(ajna.balanceOf(PROFIT_RECIPIENT) == before.profitRecipientAjna, "profit recipient changed");
    }

    function _bound(
        uint256 value,
        uint256 min,
        uint256 max
    ) internal pure returns (uint256) {
        if (max <= min) return min;
        return min + (value % (max - min + 1));
    }
}

contract FlashArbExecutorV2V3InvariantTest is InvariantBase {
    FlashArbExecutorV2V3Handler[] internal handlers;

    function setUp() public {
        _registerHandler(new FlashArbExecutorV2V3Handler(1, true));
        _registerHandler(new FlashArbExecutorV2V3Handler(1, false));
        _registerHandler(new FlashArbExecutorV2V3Handler(1e12, false));
    }

    function _registerHandler(FlashArbExecutorV2V3Handler handler) internal {
        handlers.push(handler);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.executeScenario.selector;
        selectors[1] = handler.attemptUnauthorizedExecute.selector;
        selectors[2] = handler.attemptUnauthorizedPairCallback.selector;
        selectors[3] = handler.attemptUnauthorizedDirectCallback.selector;
        targetSelector(FuzzSelector({
            addr: address(handler),
            selectors: selectors
        }));
    }

    function invariant_profitRecipientOnlyReceivesTradeDelta() public view {
        for (uint256 i = 0; i < handlers.length; i++) {
            FlashArbExecutorV2V3Handler handler = handlers[i];
            assertEq(
                handler.profitRecipientBalance(),
                handler.expectedProfitBalance(),
                "profit recipient balance should equal cumulative trade profit only"
            );
        }
    }

    function invariant_executorKeepsOnlyPreseededAjna() public view {
        for (uint256 i = 0; i < handlers.length; i++) {
            FlashArbExecutorV2V3Handler handler = handlers[i];
            assertEq(
                handler.executorResidualBalance(),
                handler.expectedExecutorResidual(),
                "executor should retain only explicitly pre-seeded AJNA"
            );
        }
    }

    function invariant_executorDoesNotRetainQuoteTokens() public view {
        for (uint256 i = 0; i < handlers.length; i++) {
            FlashArbExecutorV2V3Handler handler = handlers[i];
            assertEq(
                handler.executorQuoteBalance(),
                0,
                "executor should not retain quote-token balances after successful runs"
            );
        }
    }

    function invariant_flashPairNeverLosesPrincipal() public view {
        for (uint256 i = 0; i < handlers.length; i++) {
            FlashArbExecutorV2V3Handler handler = handlers[i];
            assertEq(
                handler.flashPairBalance(),
                handler.expectedFlashPairAjnaBalance(),
                "flash pair should keep principal and accrue exactly the configured fee"
            );
        }
    }
}
