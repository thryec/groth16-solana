pragma circom 2.1.6;

include "poseidon.circom";

template Preimage() {
    signal input preimage;
    signal input hash;

    component p = Poseidon(1);
    p.inputs[0] <== preimage;
    p.out === hash;
}

component main {public [hash]} = Preimage();
