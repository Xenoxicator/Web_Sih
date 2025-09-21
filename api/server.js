"scripts": {
  "start": "node api/server.js"
}


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

// Create uploads directory if it doesn't exist
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = uuidv4() + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

// Initialize SQLite database
const db = new sqlite3.Database('./civic_issues.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Initialize database tables
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
        )
    `;

    const createCommentsTable = `
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            issue_id INTEGER,
            comment TEXT NOT NULL,
            author TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (issue_id) REFERENCES issues (id)
        )
    `;

    db.run(createIssuesTable, (err) => {
        if (err) {
            console.error('Error creating issues table:', err.message);
        } else {
            console.log('Issues table ready');
        }
    });

    db.run(createCommentsTable, (err) => {
        if (err) {
            console.error('Error creating comments table:', err.message);
        } else {
            console.log('Comments table ready');
        }
    });
}

// API Routes

// Get all issues
app.get('/api/issues', (req, res) => {
    const { status, category, priority } = req.query;
    let query = 'SELECT * FROM issues';
    let params = [];
    let conditions = [];

    if (status) {
        conditions.push('status = ?');
        params.push(status);
    }
    if (category) {
        conditions.push('category = ?');
        params.push(category);
    }
    if (priority) {
        conditions.push('priority = ?');
        params.push(priority);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows);
        }
    });
});

// Get single issue by ID
app.get('/api/issues/:id', (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT * FROM issues WHERE id = ?', [id], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Issue not found' });
        } else {
            res.json(row);
        }
    });
});

// Create new issue
app.post('/api/issues', upload.single('image'), (req, res) => {
    const {
        title,
        category,
        location,
        description,
        priority,
        reporter_name,
        reporter_email,
        reporter_phone
    } = req.body;

    if (!title || !category || !location || !description || !priority) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const imagePath = req.file ? req.file.filename : null;

    const query = `
        INSERT INTO issues (
            title, category, location, description, priority,
            reporter_name, reporter_email, reporter_phone, image_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
        title, category, location, description, priority,
        reporter_name, reporter_email, reporter_phone, imagePath
    ];

    db.run(query, params, function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({
                id: this.lastID,
                message: 'Issue created successfully'
            });
        }
    });
});

// Update issue status
app.put('/api/issues/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'in-progress', 'resolved', 'rejected'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    const query = 'UPDATE issues SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
    
    db.run(query, [status, id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (this.changes === 0) {
            res.status(404).json({ error: 'Issue not found' });
        } else {
            res.json({ message: 'Status updated successfully' });
        }
    });
});

// Get comments for an issue
app.get('/api/issues/:id/comments', (req, res) => {
    const { id } = req.params;
    
    db.all(
        'SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at DESC',
        [id],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
            } else {
                res.json(rows);
            }
        }
    );
});

// Add comment to an issue
app.post('/api/issues/:id/comments', (req, res) => {
    const { id } = req.params;
    const { comment, author } = req.body;

    if (!comment) {
        return res.status(400).json({ error: 'Comment is required' });
    }

    const query = 'INSERT INTO comments (issue_id, comment, author) VALUES (?, ?, ?)';
    
    db.run(query, [id, comment, author || 'Anonymous'], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({
                id: this.lastID,
                message: 'Comment added successfully'
            });
        }
    });
});

// Get statistics
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
            if (err) {
                console.error(`Error getting ${key} stats:`, err.message);
                stats[key] = 0;
            } else {
                stats[key] = row.count;
            }
            
            completed++;
            if (completed === Object.keys(queries).length) {
                res.json(stats);
            }
        });
    });
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../SIH_Civic.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large' });
        }
    }
    res.status(500).json({ error: error.message });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err.message);
        } else {
            console.log('Database connection closed');
        }
        process.exit(0);
    });
});
