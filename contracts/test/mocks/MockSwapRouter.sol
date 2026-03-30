// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Like, ISwapRouterLike} from "../../FlashArbExecutor.sol";

contract MockSwapRouter is ISwapRouterLike {
    address public immutable quoteToken;
    address public immutable ajnaToken;

    uint256 public nextAmountOut;
    uint256 public lastAmountIn;
    bytes public lastPath;

    constructor(address quoteToken_, address ajnaToken_) {
        quoteToken = quoteToken_;
        ajnaToken = ajnaToken_;
    }

    function setNextAmountOut(uint256 amountOut) external {
        nextAmountOut = amountOut;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        lastAmountIn = params.amountIn;
        lastPath = params.path;

        require(
            IERC20Like(quoteToken).transferFrom(msg.sender, address(this), params.amountIn),
            "QUOTE_IN"
        );
        require(nextAmountOut >= params.amountOutMinimum, "MIN_OUT");
        require(
            IERC20Like(ajnaToken).transfer(params.recipient, nextAmountOut),
            "AJNA_OUT"
        );

        return nextAmountOut;
    }
}
