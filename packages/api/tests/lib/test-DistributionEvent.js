const test = require('ava');

const { randomString } = require('@cumulus/common/test-utils');

const DistributionEvent = require('../../lib/DistributionEvent');
const {
  // fakeCollectionFactory,
  fakeGranuleFactoryV2,
  fakeFileFactory
} = require('../../lib/testUtils');
const FileClass = require('../../models/files');
const Granule = require('../../models/granules');

test.before(async (t) => {
  process.env.FilesTable = randomString();
  process.env.GranulesTable = randomString();

  t.context.fileModel = new FileClass();
  t.context.granuleModel = new Granule();

  await t.context.granuleModel.createTable();
  await t.context.fileModel.createTable();
});

test.beforeEach(async (t) => {
  t.context.username = randomString();
  t.context.authDownloadLogLine = 'fe3f16719bb293e218f6e5fea86e345b0a696560d784177395715b24041da90e my-dist-bucket '
    + '[01/June/1981:00:02:13 +0000] 192.0.2.3 arn:aws:iam::000000000000:user/joe '
    + '1CB21F5399FF76C5 REST.GET.OBJECT my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf '
    + '"GET /my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf HTTP/1.1" '
    + `200 - 807 807 22 22 "-" "RAIN Egress App for userid=${t.context.username}" - `
    + '+AzZ/OMoP7AqT6ZHEOdLoFbmTn+TKKh0UBxKQkpJthfh2f4GE4GwT3VQHxuFhC42O1gCWWYFsiw= SigV4 '
    + 'ECDHE-RSA-AES128-GCM-SHA256 AuthHeader s3.amazonaws.com TLSv1.2';
});

test('DistributionEvent.isDistributionEvent() returns false for non distribution event', (t) => {
  t.false(DistributionEvent.isDistributionEvent('testing'));
  t.false(DistributionEvent.isDistributionEvent('REST.GET.OBJECT'));
  t.false(DistributionEvent.isDistributionEvent('userid=test'));
});

test('DistributionEvent.isDistributionEvent() returns true for distribution event', (t) => {
  t.true(DistributionEvent.isDistributionEvent('REST.GET.OBJECT userid=test'));
  t.true(DistributionEvent.isDistributionEvent(t.context.authDownloadLogLine));
});

test('DistributionEvent.toString() returns correct output', async (t) => {
  const granule = fakeGranuleFactoryV2({
    collectionId: 'MYD13Q1___006',
    files: [
      fakeFileFactory({
        bucket: 'my-dist-bucket',
        key: 'my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf',
        type: 'data'
      })
    ]
  });

  await t.context.granuleModel.create(granule);
  await t.context.fileModel.createFilesFromGranule(granule);

  const distributionEvent = new DistributionEvent(t.context.authDownloadLogLine);
  const output = await distributionEvent.toString();
  t.is(
    output,
    [
      '01-JUN-81 12:02:13 AM',
      t.context.username,
      '192.0.2.3',
      's3://my-dist-bucket/my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf',
      '807',
      'S',
      'MYD13Q1',
      '006',
      granule.granuleId,
      'SCIENCE',
      'HTTPS'
    ].join('|&|')
  );
});
