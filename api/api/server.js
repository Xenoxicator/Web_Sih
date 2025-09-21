const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('.'));

// Ensure uploads directory exists
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) cb(null, true);
    else cb(new Error('Invalid file type'));
  }
});

// Database setup
const db = new sqlite3.Database('./civic_issues.db', (err) => {
  if (err) console.error('Error opening database:', err.message);
  else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

function initializeDatabase() {
  const createIssuesTable = `
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      reporter_name TEXT,
      reporter_email TEXT,
      reporter_phone TEXT,
      image_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`;

  const createCommentsTable = `
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER,
      comment TEXT NOT NULL,
      author TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (issue_id) REFERENCES issues (id)
    )`;

  db.run(createIssuesTable);
  db.run(createCommentsTable);
}

// API Routes
app.get('/api/issues', (req, res) => {
  const { status, category, priority } = req.query;
  let query = 'SELECT * FROM issues';
  let params = [];
  let conditions = [];

  if (status) { conditions.push('status = ?'); params.push(status); }
  if (category) { conditions.push('category = ?'); params.push(category); }
  if (priority) { conditions.push('priority = ?'); params.push(priority); }

  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC';

  db.all(query, params, (err, rows) => {
    if (err) res.status(500).json({ error: err.message });
    else res.json(rows);
  });
});

app.get('/api/issues/:id', (req, res) => {
  db.get('SELECT * FROM issues WHERE id = ?', [req.params.id], (err, row) => {
    if (err) res.status(500).json({ error: err.message });
    else if (!row) res.status(404).json({ error: 'Issue not found' });
    else res.json(row);
  });
});

app.post('/api/issues', upload.single('image'), (req, res) => {
  const { title, category, location, description, priority, reporter_name, reporter_email, reporter_phone } = req.body;
  if (!title || !category || !location || !description || !priority) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const query = `
    INSERT INTO issues (
      title, category, location, description, priority,
      reporter_name, reporter_email, reporter_phone, image_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [title, category, location, description, priority,
    reporter_name, reporter_email, reporter_phone, req.file ? req.file.filename : null];

  db.run(query, params, function (err) {
    if (err) res.status(500).json({ error: err.message });
    else res.json({ id: this.lastID, message: 'Issue created successfully' });
  });
});

app.put('/api/issues/:id/status', (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'in-progress', 'resolved', 'rejected'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.run('UPDATE issues SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, req.params.id], function (err) {
    if (err) res.status(500).json({ error: err.message });
    else if (this.changes === 0) res.status(404).json({ error: 'Issue not found' });
    else res.json({ message: 'Status updated successfully' });
  });
});

app.get('/api/issues/:id/comments', (req, res) => {
  db.all('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at DESC', [req.params.id], (err, rows) => {
    if (err) res.status(500).json({ error: err.message });
    else res.json(rows);
  });
});

app.post('/api/issues/:id/comments', (req, res) => {
  const { comment, author } = req.body;
  if (!comment) return res.status(400).json({ error: 'Comment is required' });

  db.run('INSERT INTO comments (issue_id, comment, author) VALUES (?, ?, ?)',
    [req.params.id, comment, author || 'Anonymous'], function (err) {
      if (err) res.status(500).json({ error: err.message });
      else res.json({ id: this.lastID, message: 'Comment added successfully' });
    });
});

app.get('/api/stats', (req, res) => {
  const queries = {
    total: 'SELECT COUNT(*) as count FROM issues',
    pending: 'SELECT COUNT(*) as count FROM issues WHERE status = "pending"',
    inProgress: 'SELECT COUNT(*) as count FROM issues WHERE status = "in-progress"',
    resolved: 'SELECT COUNT(*) as count FROM issues WHERE status = "resolved"'
  };

  const stats = {};
  let completed = 0;

  Object.keys(queries).forEach(key => {
    db.get(queries[key], (err, row) => {
      stats[key] = err ? 0 : row.count;
      if (++completed === Object.keys(queries).length) res.json(stats);
    });
  });
});

app.use('/uploads', express.static(uploadsDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../SIH_Civic.html'));
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large' });
  }
  res.status(500).json({ error: error.message });
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  db.close(() => process.exit(0));
});
