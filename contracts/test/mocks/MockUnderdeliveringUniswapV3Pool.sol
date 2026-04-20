// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Like, IUniswapV3FlashCallback} from "../../FlashArbExecutorBase.sol";

// Test-only mock for a malicious / misbehaving Uniswap V3 pool that flash()es
// FEWER tokens than requested. Used to lock in the executor's balance-delta check
// against under-delivery attacks. Deployed via CREATE2 so its address matches the
// canonical factory verification in the executor — the partnering factory is
// MockUnderdeliveringUniswapV3Factory below.
interface IMockUnderdeliveringUniswapV3Factory {
    function parameters()
        external
        view
        returns (
            address token0,
            address token1,
            uint24 fee,
            uint256 fee0,
            uint256 fee1,
            uint256 shortfall
        );
}

contract MockUnderdeliveringUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint256 public immutable fee0;
    uint256 public immutable fee1;
    uint256 public immutable shortfall;

    constructor() {
        (
            address token0_,
            address token1_,
            uint24 fee_,
            uint256 fee0_,
            uint256 fee1_,
            uint256 shortfall_
        ) = IMockUnderdeliveringUniswapV3Factory(msg.sender).parameters();

        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        fee0 = fee0_;
        fee1 = fee1_;
        shortfall = shortfall_;
    }

    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external {
        uint256 delivered0 = amount0 >= shortfall ? amount0 - shortfall : 0;
        uint256 delivered1 = amount1 >= shortfall ? amount1 - shortfall : 0;

        if (delivered0 > 0) {
            require(IERC20Like(token0).transfer(recipient, delivered0), "FLASH0");
        }
        if (delivered1 > 0) {
            require(IERC20Like(token1).transfer(recipient, delivered1), "FLASH1");
        }

        // Still invoke the callback with fee values as a real pool would. The
        // executor's under-delivery check must reject this before any repay logic.
        IUniswapV3FlashCallback(recipient).uniswapV3FlashCallback(fee0, fee1, data);

        // No post-callback balance check — the executor is expected to revert
        // before the callback completes.
    }
}

contract MockUnderdeliveringUniswapV3Factory {
    struct Parameters {
        address token0;
        address token1;
        uint24 fee;
        uint256 fee0;
        uint256 fee1;
        uint256 shortfall;
    }

    Parameters public parameters;

    function createPool(
        address token0,
        address token1,
        uint24 fee,
        uint256 fee0,
        uint256 fee1,
        uint256 shortfall
    ) external returns (address pool) {
        parameters = Parameters({
            token0: token0,
            token1: token1,
            fee: fee,
            fee0: fee0,
            fee1: fee1,
            shortfall: shortfall
        });

        bytes32 salt = keccak256(abi.encode(token0, token1, fee));
        pool = address(new MockUnderdeliveringUniswapV3Pool{salt: salt}());

        delete parameters;
    }
}
