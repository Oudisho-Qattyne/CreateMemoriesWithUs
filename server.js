const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const extension = path.extname(file.originalname);
        cb(null, `photo_${timestamp}${extension}`);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    },
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Middleware
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'camera.html'));
});

app.get('/gallery', (req, res) => {
    res.sendFile(path.join(__dirname, 'gallery.html'));
});

// Upload photo
app.post('/upload', upload.single('photo'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Notify all clients about new photo
    io.emit('newPhoto', {
        filename: req.file.filename,
        timestamp: new Date().toLocaleString()
    });

    res.json({ 
        success: true, 
        filename: req.file.filename,
        message: 'Photo uploaded successfully!'
    });
});

// Get all photos
app.get('/photos', (req, res) => {
    fs.readdir(uploadsDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Unable to read photos' });
        }

        const photos = files
            .filter(file => file.match(/\.(jpg|jpeg|png|gif|webp)$/i))
            .map(file => ({
                filename: file,
                url: `/uploads/${file}`,
                timestamp: fs.statSync(path.join(uploadsDir, file)).mtime
            }))
            .sort((a, b) => b.timestamp - a.timestamp);

        res.json(photos);
    });
});

// Download all photos as zip
app.get('/download-all', (req, res) => {
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    res.attachment('camera-photos.zip');

    archive.pipe(res);

    fs.readdirSync(uploadsDir).forEach(file => {
        if (file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
            archive.file(path.join(uploadsDir, file), { name: file });
        }
    });

    archive.finalize();
});

// Download single photo
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath, `photo_${Date.now()}${path.extname(filename)}`);
    } else {
        res.status(404).json({ error: 'Photo not found' });
    }
});

// Delete all photos
app.delete('/photos', (req, res) => {
    fs.readdir(uploadsDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Unable to clear photos' });
        }

        files.forEach(file => {
            if (file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                fs.unlinkSync(path.join(uploadsDir, file));
            }
        });

        io.emit('photosCleared');
        res.json({ success: true, message: 'All photos deleted' });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`📸 Simplified Camera App running on http://localhost:${PORT}`);
});