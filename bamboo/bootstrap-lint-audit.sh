#!/bin/bash
set -e
# This script runs before lint.sh, audit.sh in the agent container
. ./bamboo/abort-if-not-pr.sh

npm install -g npm
ln -s /dev/stdout ./lerna-debug.log
npm install --no-audit
