require('dotenv').config();
const config = require('./src/config');
const DriveService = require('./src/services/drive');

(async () => {
  const ds = await new DriveService().init();
  const drive = ds.drive;
  const ROOT = config.google.driveFolderId;

  // Count all artist folders
  let allArtists = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${ROOT}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken,
    });
    allArtists.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log('Total artist folders:', allArtists.length);

  // Check structure of first 5 artists
  for (const artist of allArtists.slice(0, 5)) {
    console.log(`\n--- ${artist.name} ---`);
    const children = await drive.files.list({
      q: `'${artist.id}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 1000,
    });
    const folders = children.data.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const files = children.data.files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
    console.log(`  Subfolders: [${folders.map(f => f.name).join(', ')}]`);
    console.log(`  Direct files: ${files.length}`);

    for (const sub of folders.slice(0, 3)) {
      // Count files in tier
      let count = 0;
      let pt2 = null;
      do {
        const r = await drive.files.list({
          q: `'${sub.id}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, mimeType)',
          pageSize: 1000,
          pageToken: pt2,
        });
        count += (r.data.files || []).length;
        pt2 = r.data.nextPageToken;
      } while (pt2);
      console.log(`    - ${sub.name}: ${count} items`);
    }
  }

  // Also check: how many total images can Drive find with a flat query?
  console.log('\n--- Checking total image count via flat query ---');
  let totalImages = 0;
  pageToken = null;
  const startTime = Date.now();
  do {
    const res = await drive.files.list({
      q: `mimeType contains 'image/' and trashed = false`,
      fields: 'nextPageToken, files(id)',
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
    });
    totalImages += (res.data.files || []).length;
    pageToken = res.data.nextPageToken;
    if (totalImages % 10000 === 0) console.log(`  ... ${totalImages} images found so far (${((Date.now()-startTime)/1000).toFixed(0)}s)`);
  } while (pageToken);
  console.log(`Total images in entire Drive: ${totalImages} (${((Date.now()-startTime)/1000).toFixed(0)}s)`);
})().catch(e => console.error('ERROR:', e.message));
