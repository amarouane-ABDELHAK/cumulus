'use strict';

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
    await pdrModel.upsertFromCloudwatchEvent(cumulusMessage);
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
  const cumulusMessage = await getCumulusMessageFromExecutionEvent(event);

  await Promise.all([
    saveExecutionToDb(cumulusMessage),
    saveGranulesToDb(cumulusMessage),
    savePdrToDb(cumulusMessage)
  ]);
};

module.exports = {
  handler,
  saveExecutionToDb,
  saveGranulesToDb
};
