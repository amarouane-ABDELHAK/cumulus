'use strict';

const get = require('lodash.get');
const log = require('@cumulus/common/log');
const { getMessageExecutionArn } = require('@cumulus/common/message');
const { Execution, Granule, Pdr } = require('../models');
const { getCumulusMessageFromExecutionEvent } = require('../lib/cwSfExecutionEventUtils');

const saveExecutionToDb = async (cumulusMessage) => {
  const executionModel = new Execution();
  try {
    await executionModel.storeExecutionFromCumulusMessage(cumulusMessage);
  } catch (err) {
    const executionArn = getMessageExecutionArn(cumulusMessage);
    log.fatal(`Failed to create/update database record for execution ${executionArn}: ${err.message}`);
  }
};

const savePdrToDb = async (cumulusMessage) => {
  const pdrModel = new Pdr();
  try {
    await pdrModel.storePdrsFromCumulusMessage(cumulusMessage);
  } catch (err) {
    const executionArn = getMessageExecutionArn(cumulusMessage);
    log.fatal(`Failed to create/update PDR database record for execution ${executionArn}: ${err.message}`);
  }
};

const saveGranulesToDb = async (cumulusMessage) => {
  const granuleModel = new Granule();

  try {
    await granuleModel.storeGranulesFromCumulusMessage(cumulusMessage);
  } catch (err) {
    const executionArn = getMessageExecutionArn(cumulusMessage);
    log.fatal(`Failed to create/update granule records for execution ${executionArn}: ${err.message}`);
  }
};

const handler = async (event) => {
  const sqsMessages = event.Records;

  return Promise.all(sqsMessages.map(async (message) => {
    const executionEvent = JSON.parse(get(message, 'Body', get(message, 'body', '{}')));
    const cumulusMessage = await getCumulusMessageFromExecutionEvent(executionEvent);

    await Promise.all([
      saveExecutionToDb(cumulusMessage),
      saveGranulesToDb(cumulusMessage),
      savePdrToDb(cumulusMessage)
    ]);
  }));
};

module.exports = {
  handler,
  saveExecutionToDb,
  saveGranulesToDb,
  savePdrToDb
};
