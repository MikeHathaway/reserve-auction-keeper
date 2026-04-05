// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TestBase} from "./TestBase.sol";

struct FuzzSelector {
    address addr;
    bytes4[] selectors;
}

abstract contract InvariantBase is TestBase {
    address[] internal targetedContracts_;
    FuzzSelector[] internal targetedSelectors_;

    function targetContract(address target) internal {
        targetedContracts_.push(target);
    }

    function targetContracts() public view returns (address[] memory) {
        return targetedContracts_;
    }

    function targetSelector(FuzzSelector memory selector) internal {
        targetedSelectors_.push(selector);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory) {
        return targetedSelectors_;
    }
}
