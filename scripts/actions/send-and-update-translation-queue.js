const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const serializeMDX = require('./serialize-mdx');
const { vendorRequest, getAccessToken } = require('./utils/vendor-request');
const {
  addJob,
  updateJob,
  getJobs,
  getTranslations,
  updateTranslation,
  addTranslationsJobsRecord,
  getTranslationsJobsRecords,
} = require('./translation_workflow/database');

/**
 * @typedef {Object} Page
 * @property {string} file The filepath for the page (from the project root).
 * @property {string} html The HTML serialized content for the page.
 */

// NOTE: the vendor requires the locales in a different format
// We should consider this into the Gatsby config for each locale.
const LOCALE_IDS = {
  jp: 'ja-JP',
};

const PROJECT_ID = process.env.TRANSLATION_VENDOR_PROJECT;
const DOCS_SITE_URL = 'https://docs.newrelic.com';

/**
 * Take a list of filepaths (grouped by locale) and fetches the HTML content.
 * @param {Object<string, string[]>} listByLocale The queue of slugs to be translated.
 * @returns {Object<string, Promise<Page[]>>}
 */
const getContent = (listByLocale) => {
  return Object.entries(listByLocale).reduce((acc, [locale, slugs]) => {
    return {
      ...acc,
      [locale]: Promise.all(
        slugs
          .filter((slug) => {
            /**
             * If a doc doesn't exist, it must have been renamed or deleted. In
             * that case, it is safe to ignore. If we skip including a doc in
             * this step, it won't become a failed upload, and will then be
             * cleaned up from the queue.
             */
            console.log(
              `Skipping over -- ${slug} -- since it no longer exists.`
            );
            return fs.existsSync(path.join(process.cwd(), slug));
          })
          .map(async (slug) => {
            const mdx = fs.readFileSync(path.join(process.cwd(), slug));
            const html = await serializeMDX(mdx);
            return { file: slug, html };
          })
      ),
    };
  }, {});
};

/**
 * @param {string} locale The locale that this file should be translated to.
 * @param {string} batchUid The batch that is expecting this file.
 * @param {string} accessToken
 * @returns {(page: Page) => Promise<{code: string, slug: string, locale: string>}
 */
const uploadFile = (locale, batchUid, accessToken) => async (page) => {
  const filename = `${Buffer.from(locale + page.file).toString('base64')}.html`;
  const filepath = path.join(process.cwd(), filename);
  fs.writeFileSync(filepath, page.html, 'utf8');

  const form = new FormData();
  form.append('fileType', 'html');
  form.append('localeIdsToAuthorize[]', LOCALE_IDS[locale]);
  form.append('fileUri', page.file);
  form.append('file', fs.createReadStream(filepath));

  const url = new URL(
    `/job-batches-api/v2/projects/${PROJECT_ID}/batches/${batchUid}/file`,
    process.env.TRANSLATION_VENDOR_API_URL
  );

  const options = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: form,
  };

  const resp = await fetch(url.href, options);
  const { response } = await resp.json();
  const { code } = response;

  if (code === 'ACCEPTED' && resp.ok) {
    console.log(`[*] Successfully uploaded ${page.file}.`);
    await sendPageContext(page.file, accessToken);
  } else {
    console.error(
      `[!] Unable to upload ${page.file}. Code was ${code}. Response status: ${resp.status} -- ${resp.statusText}`
    );
  }

  return { code, locale, slug: page.file };
};

/**
 * Sends the html file as a visual context for each uploaded file
 * @param {string} fileUri
 * @param {string} accessToken
 * @returns {Promise}
 */
const sendPageContext = async (fileUri, accessToken) => {
  const filepath = fileUri.replace(`src/content/`, '');
  const slug = filepath.replace(`.mdx`, '');
  const contextUrl = new URL(slug, DOCS_SITE_URL);
  const res = await fetch(contextUrl.href);
  const html = await res.text();

  const form = new FormData();
  form.append('content', html, {
    contentType: 'text/html',
    filename: fileUri,
  });
  form.append('name', contextUrl.href);

  const url = new URL(
    `/context-api/v2/projects/${PROJECT_ID}/contexts/upload-and-match-async`,
    process.env.TRANSLATION_VENDOR_API_URL
  );

  const options = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: form,
  };

  const resp = await fetch(url.href, options);

  const { response } = await resp.json();
  const { code } = response;

  if (code === 'SUCCESS' && resp.ok) {
    console.log(`[*] Successfully uploaded ${fileUri} context.`);
  } else {
    console.error(`[!] Unable to upload ${fileUri} context.`);
  }
};

/**
 * Sends HTML content to the vendor by creating jobs, batches, and uploading
 * files. On success, this will return the batchUid for each locale.
 * @param {Object<string, Page[]>} content
 * @param {string} accessToken
 * @returns {Promise<{batchUids: string[], fileResponses: Object[]>}
 */
const sendContentToVendor = async (content, accessToken) => {
  // 1) Create a job for each locale - save the jobUid for storage
  const jobRequests = Object.keys(content).map((locale) => {
    const body = {
      jobName: `Gatsby Translation Queue (${locale}) ${new Date().toLocaleString()}`,
      targetLocaleIds: [LOCALE_IDS[locale]],
    };
    return vendorRequest({
      method: 'POST',
      endpoint: `/jobs-api/v3/projects/${PROJECT_ID}/jobs`,
      body,
      accessToken,
    });
  });

  const jobsResponses = await Promise.all(jobRequests);
  const jobUids = jobsResponses.map((resp) => resp.translationJobUid);
  console.log(`[*] Successfully created jobs: ${jobUids.join(', ')}`);

  const queueTranslationsJobsRecord = jobUids.map((jobUid) =>
    addTranslationsJobsRecord(jobUid)
  );
  const createTranslationJobRecord = await Promise.all(queueTranslationsJobsRecord)
  console.log(
    `[*] Successfully created job record: ${JSON.stringify(
      createTranslationJobRecord
    )}`
  );
  // 2) Create a batch for each job - save bachUid for storage
  const pages = await Promise.all(Object.values(content));
  const batchRequests = jobUids.map((jobUid, idx) => {
    const body = {
      authorize: false,
      translationJobUid: jobUid,
      fileUris: pages[idx].map(({ file }) => file),
    };

    return vendorRequest({
      method: 'POST',
      endpoint: `/job-batches-api/v2/projects/${PROJECT_ID}/batches`,
      body,
      accessToken,
    });
  });

  const batchResponses = await Promise.all(batchRequests);
  const initialStatus = 'PENDING';
  for (const response of batchResponses) {
    await addJob(response.job_uid, response.batch_uid, initialStatus);
  }
  console.log(
    `[*] Successfully created job/batch records: ${jobRecords.join(', ')}`
  );
  const batchUids = batchResponses.map((resp) => resp.batchUid);

  // 3) Upload files to the batches job
  const fileRequests = batchUids.flatMap((batchUid, idx) => {
    const locale = Object.keys(content)[idx];

    return pages[idx].map(uploadFile(locale, batchUid, accessToken));
  });

  const fileResponses = await Promise.all(fileRequests);
  const successfulUploads = fileResponses.filter(
    ({ code }) => code === 'ACCEPTED'
  );
  await updateStatus(successfulUploads, 'IN_PROGRESS');
  console.log(
    `[*] Successfully uploaded ${successfulUploads.length} / ${fileResponses.length} files`
  );

  return { fileResponses };
};

/**
 * @param {string[]} batchUids A list of vendor UIDs to be added to the `being_translated` queue.
 * @param {string} status Status of a job
 */
const updateStatus = async (successfulUploads, status) => {
  for (const upload of successfulUploads) {
    const batch_uid = upload.batchUid;
    const job = await getJobs({ batch_uid });
    const translationId = await getTranslationsJobsRecords({ jobId: job.id });
    await updateJob(job.id, { status });
    await updateTranslation(translationId, { status });
  }
};

/**
 * @param {Object[]} failedUploads A list of failed requests to the vendor
 */
const outputFailedUploads = async (failedUploads) => {
  for (const failedUpload of failedUploads) {
    console.log(`    [!] ${JSON.stringify(failedUpload)}`);
  }
};

/** Entrypoint. */
const main = async () => {
  const pendingJobs = await getTranslations({ status: 'PENDING' });
  const listByLocale = pendingJobs.reduce(
    (acc, job) => ({
      ...acc,
      [job.locale]: [...(acc[job.locale] || []), job.slug],
    }),
    []
  );
  const content = getContent(listByLocale);
  try {
    const accessToken = await getAccessToken();
    const { fileResponses } = await sendContentToVendor(content, accessToken);

    const failedUploads = fileResponses.filter(
      ({ code }) => code !== 'ACCEPTED'
    );
    console.log(`[*] ${failedUploads.length} pages failed to upload.`);
    outputFailedUploads(failedUploads);

    process.exit(failedUploads.length ? 1 : 0);
  } catch (error) {
    console.error(`[!] Unable to send data to vendor`);
    console.log(error);

    process.exit(1);
  }
};

/**
 * This allows us to check if the script was invoked directly from the command line, i.e 'node validate_packs.js', or if it was imported.
 * This would be true if this was used in one of our GitHub workflows, but false when imported for use in a test.
 * See here: https://nodejs.org/docs/latest/api/modules.html#modules_accessing_the_main_module
 */
if (require.main === module) {
  main();
}

module.exports = { main, getContent };
