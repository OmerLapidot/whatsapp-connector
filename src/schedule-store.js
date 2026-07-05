// Load / mutate the scheduled-jobs file (a JSON array of job objects).
const fs = require('fs');
const crypto = require('crypto');

function loadJobs(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    return []; // corrupt file: treat as empty rather than crashing the daemon
  }
}

function saveJobs(filePath, jobs) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2) + '\n');
  fs.renameSync(tmp, filePath); // atomic on POSIX: a crash mid-write leaves the prior file intact
}

function addJob(filePath, job) {
  const jobs = loadJobs(filePath);
  const stored = { id: crypto.randomBytes(6).toString('hex'), status: 'active', lastResult: null, ...job };
  jobs.push(stored);
  saveJobs(filePath, jobs);
  return stored;
}

function updateJob(filePath, id, patch) {
  const jobs = loadJobs(filePath);
  const i = jobs.findIndex((j) => j.id === id);
  if (i === -1) { const e = new Error('no scheduled job with id ' + id); e.code = 'NOT_FOUND'; throw e; }
  jobs[i] = { ...jobs[i], ...patch };
  saveJobs(filePath, jobs);
  return jobs[i];
}

function cancelJob(filePath, id) {
  const jobs = loadJobs(filePath);
  const job = jobs.find((j) => j.id === id);
  if (!job) { const e = new Error('no scheduled job with id ' + id); e.code = 'NOT_FOUND'; throw e; }
  if (job.status !== 'active') { const e = new Error('job ' + id + ' is already ' + job.status); e.code = 'NOT_ACTIVE'; throw e; }
  job.status = 'cancelled';
  saveJobs(filePath, jobs);
  return job;
}

function listJobs(filePath, { all = false } = {}) {
  const jobs = loadJobs(filePath);
  return all ? jobs : jobs.filter((j) => j.status === 'active');
}

module.exports = { loadJobs, saveJobs, addJob, updateJob, cancelJob, listJobs };
