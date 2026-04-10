// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Like} from "../../FlashArbExecutor.sol";
import {IUniswapV2RouterLike} from "../../FlashArbExecutorV3V2.sol";

contract MockUniswapV2Router is IUniswapV2RouterLike {
    address public immutable quoteToken;
    address public immutable ajnaToken;

    uint256 public nextAmountOut;
    uint256 public lastAmountIn;
    address[] public lastPath;

    constructor(address quoteToken_, address ajnaToken_) {
        quoteToken = quoteToken_;
        ajnaToken = ajnaToken_;
    }

    function setNextAmountOut(uint256 amountOut) external {
        nextAmountOut = amountOut;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        lastAmountIn = amountIn;
        delete lastPath;
        for (uint256 i = 0; i < path.length; i++) {
            lastPath.push(path[i]);
        }

        require(
            IERC20Like(quoteToken).transferFrom(msg.sender, address(this), amountIn),
            "QUOTE_IN"
        );
        require(nextAmountOut >= amountOutMin, "MIN_OUT");
        require(
            IERC20Like(ajnaToken).transfer(to, nextAmountOut),
            "AJNA_OUT"
        );

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = nextAmountOut;
    }
}
