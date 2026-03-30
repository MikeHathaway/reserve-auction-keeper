// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Like, IUniswapV3FlashCallback} from "../../FlashArbExecutor.sol";

interface IMockUniswapV3Factory {
    function parameters()
        external
        view
        returns (
            address token0,
            address token1,
            uint24 fee,
            uint256 fee0,
            uint256 fee1
        );
}

contract MockUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint256 public immutable fee0;
    uint256 public immutable fee1;

    constructor() {
        (
            address token0_,
            address token1_,
            uint24 fee_,
            uint256 fee0_,
            uint256 fee1_
        ) = IMockUniswapV3Factory(msg.sender).parameters();

        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        fee0 = fee0_;
        fee1 = fee1_;
    }

    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external {
        uint256 token0Start = IERC20Like(token0).balanceOf(address(this));
        uint256 token1Start = IERC20Like(token1).balanceOf(address(this));

        if (amount0 > 0) {
            require(IERC20Like(token0).transfer(recipient, amount0), "FLASH0");
        }
        if (amount1 > 0) {
            require(IERC20Like(token1).transfer(recipient, amount1), "FLASH1");
        }

        IUniswapV3FlashCallback(recipient).uniswapV3FlashCallback(fee0, fee1, data);

        if (amount0 > 0) {
            require(
                IERC20Like(token0).balanceOf(address(this)) >= token0Start + fee0,
                "UNPAID0"
            );
        }
        if (amount1 > 0) {
            require(
                IERC20Like(token1).balanceOf(address(this)) >= token1Start + fee1,
                "UNPAID1"
            );
        }
    }
}
