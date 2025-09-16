const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const archiver = require('archiver');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Initialize Supabase client
// const supabaseUrl = process.env.SUPABASE_URL;
// const supabaseKey = process.env.SUPABASE_KEY;
const supabaseUrl = "https://idfmntqjmjcugnighlpz.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkZm1udHFqbWpjdWduaWdobHB6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc4NjMzMzYsImV4cCI6MjA3MzQzOTMzNn0.DAhYmeTwnJRaCb6iNWe_pe9fVU7EZg3KAiZhYDKaW_M";
const supabase = createClient(supabaseUrl, supabaseKey);

// Configure multer for memory storage (we'll upload directly to Supabase)
const storage = multer.memoryStorage();
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

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/gallery', (req, res) => {
    res.sendFile(path.join(__dirname, 'gallery.html'));
});

// Upload photo to Supabase
app.post('/upload', upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Generate a unique filename
        const fileExtension = path.extname(req.file.originalname);
        const fileName = `photo_${Date.now()}_${uuidv4()}${fileExtension}`;
        
        // Upload to Supabase Storage
        const { data, error } = await supabase
            .storage
            .from(`nayagraduationparty`)
            .upload(fileName, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (error) {
            console.error('Supabase upload error:', error);
            return res.status(500).json({ error: 'Failed to upload photo' });
        }

        // Get public URL
        const { data: { publicUrl } } = supabase
            .storage
            .from(`nayagraduationparty`)
            .getPublicUrl(fileName);

        // Notify all clients about new photo
        io.emit('newPhoto', {
            filename: fileName,
            url: publicUrl,
            timestamp: new Date().toLocaleString()
        });

        res.json({ 
            success: true, 
            filename: fileName,
            url: publicUrl,
            message: 'Photo uploaded successfully!'
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all photos from Supabase
// Get all photos and videos from Supabase
app.get('/media', async (req, res) => {
    try {
        const type = req.query.type; // 'photo', 'video', or undefined for all
        
        // List files in the bucket
        const { data, error } = await supabase
            .storage
            .from(`nayagraduationparty`)
            .list();

        if (error) {
            console.error('Supabase list error:', error);
            return res.status(500).json({ error: 'Unable to read media' });
        }

        // Filter by type if specified
        let filteredData = data;
        if (type === 'photo') {
            filteredData = data.filter(file => file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i));
        } else if (type === 'video') {
            filteredData = data.filter(file => file.name.match(/\.(mp4|mov|avi|wmv|flv|webm)$/i));
        }

        // Get public URLs for each file
        const media = await Promise.all(
            filteredData.map(async (file) => {
                const { data: { publicUrl } } = supabase
                    .storage
                    .from(`nayagraduationparty`)
                    .getPublicUrl(file.name);

                const isVideo = file.name.match(/\.(mp4|mov|avi|wmv|flv|webm)$/i);
                
                return {
                    filename: file.name,
                    url: publicUrl,
                    type: isVideo ? 'video' : 'photo',
                    timestamp: file.created_at
                };
            })
        );

        // Sort by timestamp (newest first)
        media.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        res.json(media);
    } catch (error) {
        console.error('Media error:', error);
        res.status(500).json({ error: 'Unable to read media' });
    }
});

// Download all photos as zip
app.get('/download-all', async (req, res) => {
    try {
        // List files in the bucket
        const { data, error } = await supabase
            .storage
            .from(`nayagraduationparty`)
            .list();

        if (error) {
            console.error('Supabase list error:', error);
            return res.status(500).json({ error: 'Unable to download media' });
        }

        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        res.attachment('camera-media.zip');
        archive.pipe(res);

        // Add each file to the archive
        for (const file of data) {
            // Include both image and video files
            if (file.name.match(/\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|wmv|flv|webm|mkv)$/i)) {
                try {
                    // Download file from Supabase
                    const { data: fileData, error: downloadError } = await supabase
                        .storage
                        .from(`nayagraduationparty`)
                        .download(file.name);

                    if (!downloadError) {
                        archive.append(Buffer.from(await fileData.arrayBuffer()), { name: file.name });
                    } else {
                        console.error('Error downloading file:', file.name, downloadError);
                    }
                } catch (fileError) {
                    console.error('Error processing file:', file.name, fileError);
                }
            }
        }

        archive.finalize();
        
        // Handle archive errors
        archive.on('error', (err) => {
            console.error('Archive error:', err);
            res.status(500).json({ error: 'Failed to create zip file' });
        });
    } catch (error) {
        console.error('Download all error:', error);
        res.status(500).json({ error: 'Unable to download media' });
    }
});
// Download single photo
app.get('/download/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        
        // Download the file from Supabase
        const { data, error } = await supabase
            .storage
            .from(`nayagraduationparty`)
            .download(filename);

        if (error) {
            console.error('Supabase download error:', error);
            return res.status(404).json({ error: 'Photo not found' });
        }

        // Convert to buffer and send
        const arrayBuffer = await data.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Disposition', `attachment; filename="photo_${Date.now()}${path.extname(filename)}"`);
        res.send(buffer);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete all photos
app.delete('/photos', async (req, res) => {
    try {
        // List all files
        const { data, error } = await supabase
            .storage
            .from(`nayagraduationparty`)
            .list();

        if (error) {
            console.error('Supabase list error:', error);
            return res.status(500).json({ error: 'Unable to clear photos' });
        }

        // Extract file names
        const filesToRemove = data.map(file => file.name);
        
        // Delete all files
        const { error: deleteError } = await supabase
            .storage
            .from(`nayagraduationparty`)
            .remove(filesToRemove);

        if (deleteError) {
            console.error('Supabase delete error:', deleteError);
            return res.status(500).json({ error: 'Unable to delete photos' });
        }

        io.emit('photosCleared');
        res.json({ success: true, message: 'All photos deleted' });
    } catch (error) {
        console.error('Delete all error:', error);
        res.status(500).json({ error: 'Unable to delete photos' });
    }
});

// Delete single photo
app.delete('/photos/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        
        // Delete from Supabase
        const { error } = await supabase
            .storage
            .from(`nayagraduationparty`)
            .remove([filename]);

        if (error) {
            console.error('Supabase delete error:', error);
            return res.status(500).json({ error: 'Failed to delete photo' });
        }

        // Notify clients
        io.emit('photoDeleted', { filename });
        res.json({ success: true, message: 'Photo deleted', filename });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete photo' });
    }
});



const videoStorage = multer.memoryStorage();
const uploadVideo = multer({
    storage: videoStorage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed!'), false);
        }
    },
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit for videos
    }
});

app.post('/upload-video', uploadVideo.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded' });
        }

        // Generate a unique filename
        const fileExtension = path.extname(req.file.originalname);
        const fileName = `video_${Date.now()}_${uuidv4()}${fileExtension}`;
        
        // Upload to Supabase Storage
        const { data, error } = await supabase
            .storage
            .from(`nayagraduationparty`)
            .upload(fileName, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (error) {
            console.error('Supabase video upload error:', error);
            return res.status(500).json({ error: 'Failed to upload video' });
        }

        // Get public URL
        const { data: { publicUrl } } = supabase
            .storage
            .from(`nayagraduationparty`)
            .getPublicUrl(fileName);

        // Notify all clients about new video
        io.emit('newVideo', {
            filename: fileName,
            url: publicUrl,
            timestamp: new Date().toLocaleString()
        });

        res.json({ 
            success: true, 
            filename: fileName,
            url: publicUrl,
            message: 'Video uploaded successfully!'
        });
    } catch (error) {
        console.error('Video upload error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});