pragma circom 2.1.6;

include "comparators.circom";

template Range(nBits) {
    signal input x;
    signal input min;
    signal input max;

    component lo = LessEqThan(nBits);
    lo.in[0] <== min;
    lo.in[1] <== x;
    lo.out === 1;

    component hi = LessEqThan(nBits);
    hi.in[0] <== x;
    hi.in[1] <== max;
    hi.out === 1;
}

component main {public [min, max]} = Range(64);
