export default {
  staged: {
    "*.{js,cjs,mjs,ts,cts,mts,md,yaml,yml}": "vp fmt --check",
    "*.{js,cjs,mjs,ts,cts,mts}": "vp lint",
  },
};
