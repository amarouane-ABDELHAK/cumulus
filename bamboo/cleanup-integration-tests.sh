#!/bin/bash
set -ex
. ./bamboo/abort-if-not-pr-or-redeployment.sh
npm install
. ./bamboo/set-bamboo-env-variables.sh
. ./bamboo/abort-if-skip-integration-tests.sh

set +e
(
  set -e

  cd example

  # Delete the stack if it's a nightly build
  if [ "$DEPLOYMENT" = "cumulus-nightly" ]; then
    npm install
    echo Delete app deployment

    ./node_modules/.bin/kes cf delete \
      --kes-folder app \
      --region us-east-1 \
      --stack nightly
      --yes

    echo Delete db deployment

    ./node_modules/.bin/kes cf delete \
      --kes-folder app \
      --region us-east-1 \
      --stack nightly-db
      --yes

    echo Delete iam deployment

    ./node_modules/.bin/kes cf delete \
      --kes-folder app \
      --region us-east-1 \
      --stack nightly-iam
      --yes

    echo Delete app deployment
  else
    rm -rf node_modules

    # Needed functionality is in 1.11.3
    # Prevents breaking on a release build when it tries to install
    # the version that does not exist
    # We only need the common package for the lock-stack script
    npm install @cumulus/common@1.11.3
  fi
)
RESULT=$?
set -e

echo Unlocking stack
(cd example && node ./scripts/lock-stack.js false $DEPLOYMENT)

exit $RESULT
