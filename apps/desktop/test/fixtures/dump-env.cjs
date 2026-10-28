// Stands in for TurboDL in launch tests: writes the environment it was started with, as JSON, to $TURBODL_ENV_OUT.
"use strict";
const fs = require("node:fs");

const out = process.env.TURBODL_ENV_OUT;
if (out) {
  fs.writeFileSync(`${out}.part`, JSON.stringify(process.env));
  fs.renameSync(`${out}.part`, out);
}
