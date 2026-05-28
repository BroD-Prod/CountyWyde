const { createServer, get } = require('node:http');
require('dotenv').config();
const { getSearch, postSearch } = require('./src/controllers/searchControllers');
const { uploadFile, getUpload, deleteUpload } = require('./src/controllers/uploadControllers');
const { login, createAccount, deleteAccount, getAccount, getSession, getCounties, getStates, updateAccount, getPendingAccounts, approveAccount, rejectAccount } = require('./src/controllers/accountControllers');

const hostname = '127.0.0.1';
const port = 1337;

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');

  const path = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  try {
    if (path === '/search' && req.method === 'GET') {
      getSearch(req, res);
      return;
    }

    if (path === '/search' && req.method === 'POST') {
      postSearch(req, res);
      return;
    }

    if (path === '/upload' && req.method === 'POST') {
      uploadFile(req, res);
      return;
    }

    if (path === '/upload' && req.method === 'GET') {
      getUpload(req, res);
      return;
    }

    if (path === '/upload' && req.method === 'DELETE') {
      deleteUpload(req, res);
      return;
    }

    if (path === '/account/signup' && req.method === 'POST') {
      createAccount(req, res);
      return;
    }

    if (path === '/account/delete' && req.method === 'DELETE') {
      deleteAccount(req, res);
      return;
    }

    if (path === '/account/login' && req.method === 'POST') {
      login(req, res);
      return;
    }

    if (path === '/account/session' && req.method === 'GET') {
      getSession(req, res);
      return;
    }

    if (path === '/counties' && req.method === 'GET') {
      getCounties(req, res);
      return;
    }

    if (path === '/states' && req.method === 'GET') {
      getStates(req, res);
      return;
    }

    if (path === '/account/update' && req.method === 'PATCH') {
      updateAccount(req, res);
      return;
    }

    if (path === '/account' && req.method === 'GET') {
      getAccount(req, res);
      return;
    }

    if (path === '/admin/pending' && req.method === 'GET') {
      getPendingAccounts(req, res);
      return;
    }

    if (path === '/admin/approve' && req.method === 'PATCH') {
      approveAccount(req, res);
      return;
    }

    if (path === '/admin/reject' && req.method === 'DELETE') {
      rejectAccount(req, res);
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not Found' }));
  } catch {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});