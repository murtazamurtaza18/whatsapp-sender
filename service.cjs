const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Try to use full puppeteer package if available (includes Chromium)
let puppeteer = null;
try {
    puppeteer = require('puppeteer');
    console.log('Using full puppeteer package with Chromium');
} catch (e) {
    console.log('Full puppeteer not available, using puppeteer-core');
}

// Configuration
// Render.com provides PORT environment variable, fallback to WHATSAPP_PORT or 3003
const PORT = process.env.PORT || process.env.WHATSAPP_PORT || 3003;
const CORS_ORIGIN = process.env.WHATSAPP_CORS_ORIGIN || 'https://marketing.aispectraa.com';
const API_KEY = process.env.WHATSAPP_API_KEY || 'your-secret-api-key';
const MESSAGE_LIMIT = parseInt(process.env.WHATSAPP_MESSAGE_LIMIT || '1000');
const CONCURRENT_MESSAGES = parseInt(process.env.WHATSAPP_CONCURRENT_MESSAGES || '3');
const MESSAGE_DELAY = parseInt(process.env.WHATSAPP_MESSAGE_DELAY || '500');

// Session storage per user
const userSessions = new Map();

// Track re-initialization attempts to prevent loops
const reinitAttempts = new Map(); // userId -> { lastAttempt: timestamp, attemptCount: number }
const REINIT_COOLDOWN = 30000; // 30 seconds cooldown between re-init attempts
const MAX_REINIT_ATTEMPTS = 3; // Max attempts before giving up

// Message counter storage
const countersFile = path.join(__dirname, 'message_counters.json');

// Load message counters
function loadCounters() {
    try {
        if (fs.existsSync(countersFile)) {
            const data = fs.readFileSync(countersFile, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading counters:', error);
    }
    return {};
}

// Save message counters
function saveCounters(counters) {
    try {
        fs.writeFileSync(countersFile, JSON.stringify(counters, null, 2));
    } catch (error) {
        console.error('Error saving counters:', error);
    }
}

// Reset daily counters
function resetDailyCounters() {
    const counters = loadCounters();
    const today = new Date().toDateString();
    
    for (const userId in counters) {
        if (counters[userId].lastResetDate !== today) {
            counters[userId] = {
                messagesSent: 0,
                lastResetDate: today,
            };
        }
    }
    
    saveCounters(counters);
}

// Initialize counter for user
function getCounter(userId) {
    const counters = loadCounters();
    const today = new Date().toDateString();
    
    if (!counters[userId] || counters[userId].lastResetDate !== today) {
        counters[userId] = {
            messagesSent: 0,
            lastResetDate: today,
        };
        saveCounters(counters);
    }
    
    return counters[userId];
}

// Update counter
function updateCounter(userId, count) {
    const counters = loadCounters();
    const today = new Date().toDateString();
    
    if (!counters[userId] || counters[userId].lastResetDate !== today) {
        counters[userId] = {
            messagesSent: 0,
            lastResetDate: today,
        };
    }
    
    counters[userId].messagesSent += count;
    saveCounters(counters);
    
    return counters[userId];
}

// Initialize WhatsApp client for user
function initializeClient(userId) {
    const sessionPath = path.join(__dirname, 'sessions', `session_${userId}`);
    
    // Create sessions directory if it doesn't exist
    if (!fs.existsSync(path.join(__dirname, 'sessions'))) {
        fs.mkdirSync(path.join(__dirname, 'sessions'), { recursive: true });
    }
    
    const puppeteerConfig = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
        ],
    };
    
    // Build client options
    const clientOptions = {
        authStrategy: new LocalAuth({
            clientId: `client_${userId}`,
            dataPath: sessionPath,
        }),
    };
    
    // When full puppeteer package is available, whatsapp-web.js will use it automatically
    // We just need to pass the launch configuration
    // When puppeteer-core is used, it will also use the config
    clientOptions.puppeteer = puppeteerConfig;
    
    const client = new Client(clientOptions);
    
    // Initialize session object
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            client: null,
            sessionStatus: 'initializing',
            qrCodeData: null,
            connectedNumber: null,
        });
    }
    
    const session = userSessions.get(userId);
    session.client = client;
    session.sessionStatus = 'initializing'; // Mark as initializing
    
    // QR Code event
    client.on('qr', async (qr) => {
        try {
            const qrCodeData = await qrcode.toDataURL(qr);
            session.qrCodeData = qrCodeData;
            session.sessionStatus = 'qr_ready';
            console.log(`QR code generated for user ${userId}`);
        } catch (error) {
            console.error('Error generating QR code:', error);
        }
    });
    
    // Ready event
    client.on('ready', async () => {
        try {
            const info = await client.info;
            session.sessionStatus = 'connected';
            session.connectedNumber = info.wid.user;
            session.qrCodeData = null;
            // Reset re-initialization attempt counter on successful connection
            reinitAttempts.delete(String(userId));
            console.log(`WhatsApp client ready for user ${userId}, number: ${session.connectedNumber}`);
        } catch (error) {
            console.error('Error getting client info:', error);
        }
    });
    
    // Authentication failure
    client.on('auth_failure', (msg) => {
        console.error(`Authentication failure for user ${userId}:`, msg);
        session.sessionStatus = 'disconnected';
        session.qrCodeData = null;
    });
    
    // Disconnected
    client.on('disconnected', (reason) => {
        console.log(`Client disconnected for user ${userId}:`, reason);
        session.sessionStatus = 'disconnected';
        session.qrCodeData = null;
        session.connectedNumber = null;
    });
    
    // Initialize client
    client.initialize().catch(error => {
        console.error(`Error initializing client for user ${userId}:`, error);
        console.error(`Error details:`, {
            message: error.message,
            stack: error.stack,
            sessionPath: sessionPath,
        });
        session.sessionStatus = 'error';
        
        // Log common error causes with more detail
        if (error.message && (error.message.includes('Chromium') || error.message.includes('puppeteer') || error.message.includes('browser'))) {
            console.error('Chromium/Puppeteer error detected. This may be due to:');
            console.error('1. Missing dependencies (libnss3, libatk-bridge2.0, libxss1, libgconf-2-4, etc.)');
            console.error('2. Insufficient memory/resources on server');
            console.error('3. Permission issues with /tmp directory or session files');
            console.error('4. Node.js version incompatibility');
            console.error('5. Server restrictions (shared hosting limitations)');
            console.error(`Session path: ${sessionPath}`);
        } else if (error.message && error.message.includes('ENOENT')) {
            console.error('File not found error. Session directory may not exist or be inaccessible.');
            console.error(`Session path: ${sessionPath}`);
        } else if (error.message && error.message.includes('EACCES') || error.message.includes('permission')) {
            console.error('Permission denied error. Check file permissions for session directory.');
            console.error(`Session path: ${sessionPath}`);
        }
    });
    
    return client;
}

// Get session status
function getSessionStatus(userId) {
    const userIdStr = String(userId); // Ensure userId is a string
    
    if (!userSessions.has(userIdStr)) {
        // Initialize if not exists
        console.log(`Session not found for user ${userIdStr} in status check, initializing...`);
        initializeClient(userIdStr);
        return {
            type: 0,
            status: 'initializing',
            message: 'Initializing session... Please wait.',
        };
    }
    
    const session = userSessions.get(userIdStr);
    const counter = getCounter(userIdStr);
    
    // Handle error status - try to re-initialize automatically (with cooldown)
    if (session.sessionStatus === 'error') {
        const now = Date.now();
        const attemptInfo = reinitAttempts.get(userIdStr) || { lastAttempt: 0, attemptCount: 0 };
        
        // Check cooldown period
        const timeSinceLastAttempt = now - attemptInfo.lastAttempt;
        if (timeSinceLastAttempt < REINIT_COOLDOWN) {
            const remainingSeconds = Math.ceil((REINIT_COOLDOWN - timeSinceLastAttempt) / 1000);
            return {
                type: 0,
                status: 'error',
                message: `Session error detected. Please wait ${remainingSeconds} seconds before retry, or click "Reset Session" button to clear the error immediately.`,
            };
        }
        
        // Check max attempts
        if (attemptInfo.attemptCount >= MAX_REINIT_ATTEMPTS) {
            console.error(`Max reinit attempts (${MAX_REINIT_ATTEMPTS}) reached for user ${userIdStr}. Session files may be corrupted or server resources insufficient.`);
            console.error(`To fix: Use the "Reset Session" button or delete session files manually at: ${path.join(__dirname, 'sessions', `session_${userIdStr}`)}`);
            return {
                type: 0,
                status: 'error',
                message: 'Session initialization failed multiple times. Please click "Reset Session" button to clear the error and start fresh, or check server logs for details.',
            };
        }
        
        console.log(`Session has error status for user ${userIdStr}, attempting to re-initialize (attempt ${attemptInfo.attemptCount + 1}/${MAX_REINIT_ATTEMPTS})...`);
        
        try {
            // Update attempt tracking
            reinitAttempts.set(userIdStr, {
                lastAttempt: now,
                attemptCount: attemptInfo.attemptCount + 1,
            });
            
            // Clean up existing session
            if (session.client) {
                try {
                    session.client.destroy().catch(e => {
                        console.log(`Error destroying client: ${e.message}`);
                    });
                } catch (e) {
                    console.log(`Error destroying client: ${e.message}`);
                }
            }
            userSessions.delete(userIdStr);
            
            // Re-initialize
            initializeClient(userIdStr);
            return {
                type: 0,
                status: 'initializing',
                message: 'Session had an error. Re-initializing... Please wait.',
            };
        } catch (error) {
            console.error(`Failed to re-initialize session for user ${userIdStr}:`, error);
            return {
                type: 0,
                status: 'error',
                message: `Session initialization failed: ${error.message}. Please check server logs or restart the service.`,
            };
        }
    }
    
    // Verify client is actually ready, not just status says connected
    if (session.sessionStatus === 'connected' && session.client) {
        // Double-check client is actually ready
        // connectedNumber is set when client is ready, so this is a reliable check
        if (session.connectedNumber) {
            return {
                type: 1,
                status: 'connected',
                Number: session.connectedNumber,
                msgtype: 1,
                limit: MESSAGE_LIMIT,
                remainingcount: Math.max(0, MESSAGE_LIMIT - counter.messagesSent),
                message: 'Session connected successfully',
            };
        } else {
            // Status says connected but no number, might be stale
            console.log(`Client status is 'connected' but no connectedNumber for user ${userIdStr}, marking as disconnected`);
            session.sessionStatus = 'disconnected';
        }
    }
    
    if (session.sessionStatus === 'qr_ready' && session.qrCodeData) {
        return {
            type: 0,
            status: 'qr_ready',
            qrCodeScreenshot: session.qrCodeData,
            message: 'Please scan the QR code with your WhatsApp mobile app',
        };
    } else if (session.sessionStatus === 'initializing') {
        return {
            type: 0,
            status: 'initializing',
            message: 'Session is initializing... Please wait.',
        };
    } else if (session.sessionStatus === 'disconnected' || !session.client) {
        // Only re-initialize if not already initializing
        if (session.sessionStatus !== 'initializing') {
            console.log(`Re-initializing disconnected session for user ${userIdStr}...`);
            initializeClient(userIdStr);
            return {
                type: 0,
                status: 'initializing',
                message: 'Re-initializing session... Please wait.',
            };
        } else {
            return {
                type: 0,
                status: 'initializing',
                message: 'Session is initializing... Please wait.',
            };
        }
    }
    
    return {
        type: 0,
        status: session.sessionStatus || 'disconnected',
        message: `Session status: ${session.sessionStatus || 'unknown'}. Please refresh the page.`,
    };
}

// Send bulk messages
async function sendBulkMessages(recipients, userId) {
    const userIdStr = String(userId); // Ensure userId is a string
    
    // Log all active sessions for debugging
    console.log(`Active sessions: ${Array.from(userSessions.keys()).join(', ')}`);
    console.log(`Looking for session for user: ${userIdStr} (original: ${userId}, type: ${typeof userId})`);
    
    // Ensure session exists - if not, initialize it and wait
    if (!userSessions.has(userIdStr)) {
        console.log(`Session not found for user ${userIdStr}, initializing...`);
        initializeClient(userIdStr);
        // Wait for session object to be created
        let attempts = 0;
        while (!userSessions.has(userIdStr) && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 200));
            attempts++;
        }
        
        if (!userSessions.has(userIdStr)) {
            throw new Error('Failed to initialize session. Please refresh the page and try again.');
        }
    }
    
    const session = userSessions.get(userIdStr);
    
    // Check if session is connected
    if (!session) {
        console.log(`Session object not found for user ${userIdStr} after initialization`);
        throw new Error('Session not found. Please refresh the page and scan QR code.');
    }
    
    console.log(`Session found for user ${userIdStr}, status: ${session.sessionStatus}, has client: ${!!session.client}`);
    
    // If session is not connected, check current status
    if (session.sessionStatus !== 'connected') {
        console.log(`Session status for user ${userIdStr}: ${session.sessionStatus}`);
        
        // If disconnected or no client, try to re-initialize
        if (session.sessionStatus === 'disconnected' || !session.client) {
            console.log(`Re-initializing session for user ${userIdStr}...`);
            initializeClient(userIdStr);
            throw new Error('Session not connected. Please refresh the page, scan QR code, and wait for "Connected" status before sending.');
        }
        
        // If QR ready, tell user to scan
        if (session.sessionStatus === 'qr_ready') {
            throw new Error('Please scan the QR code first. Click Refresh to see the QR code, then scan it with your WhatsApp mobile app.');
        }
        
        // If initializing, wait a bit
        if (session.sessionStatus === 'initializing' || !session.client) {
            throw new Error('Session is initializing. Please wait a moment and try again.');
        }
        
        throw new Error(`Session not connected (status: ${session.sessionStatus}). Please scan QR code first.`);
    }
    
    // Check if client exists
    if (!session.client) {
        console.log(`Client not found for user ${userIdStr}, re-initializing...`);
        initializeClient(userIdStr);
        throw new Error('WhatsApp client not initialized. Please refresh the page and scan QR code.');
    }
    
    // Verify client is actually ready (check if it's authenticated)
    try {
        const info = await session.client.info;
        if (!info || !info.wid) {
            console.log(`Client info not available for user ${userIdStr}`);
            // Update status if client is not ready
            session.sessionStatus = 'disconnected';
            throw new Error('WhatsApp client is not fully ready. Please refresh the page and scan QR code again.');
        }
        console.log(`Client verified ready for user ${userIdStr}, number: ${info.wid.user}`);
    } catch (error) {
        console.error(`Client not ready for user ${userIdStr}:`, error.message);
        // If client info check fails, the client might be disconnected
        session.sessionStatus = 'disconnected';
        throw new Error('WhatsApp client is not ready. Please refresh the page, scan QR code again, and wait for "Connected" status.');
    }
    
    const counter = getCounter(userIdStr);
    const remaining = MESSAGE_LIMIT - counter.messagesSent;
    
    if (recipients.length > remaining) {
        throw new Error(`Cannot send ${recipients.length} messages. Only ${remaining} messages remaining in daily limit.`);
    }
    
    const results = [];
    const client = session.client;
    
    // Process in batches
    for (let i = 0; i < recipients.length; i += CONCURRENT_MESSAGES) {
        const batch = recipients.slice(i, i + CONCURRENT_MESSAGES);
        
        const batchResults = await Promise.allSettled(
            batch.map(async (recipient) => {
                try {
                    const chatId = recipient.number.includes('@') 
                        ? recipient.number 
                        : recipient.number + '@c.us';
                    
                    // Send message with attachment if available
                    if (recipient.attachment && recipient.attachment.path) {
                        try {
                            console.log(`Sending media for recipient ${recipient.id}, path: ${recipient.attachment.path}, type: ${recipient.attachment.type}`);
                            
                            // Normalize path - use path.normalize for proper path handling
                            let filePath = path.normalize(recipient.attachment.path);
                            
                            // Check if file exists
                            if (!fs.existsSync(filePath)) {
                                console.error(`File not found: ${filePath}`);
                                // Try original path
                                if (fs.existsSync(recipient.attachment.path)) {
                                    filePath = recipient.attachment.path;
                                } else {
                                    throw new Error(`Attachment file not found: ${filePath}`);
                                }
                            }
                            
                            // Get file stats to check size (videos can be large)
                            const stats = fs.statSync(filePath);
                            const fileSizeMB = stats.size / (1024 * 1024);
                            console.log(`File size: ${fileSizeMB.toFixed(2)} MB`);
                            
                            // Warn if file is very large (WhatsApp has limits)
                            if (fileSizeMB > 64) {
                                console.warn(`Warning: File size (${fileSizeMB.toFixed(2)} MB) exceeds WhatsApp's recommended limit of 64 MB`);
                            }
                            
                            console.log(`Loading media from path: ${filePath}`);
                            
                            const { MessageMedia } = require('whatsapp-web.js');
                            
                            // For videos, try multiple approaches
                            let media;
                            if (recipient.attachment.type === 'video') {
                                const ext = path.extname(recipient.attachment.filename || filePath).toLowerCase();
                                
                                // Determine MIME type
                                let mimetype = 'video/mp4'; // default
                                if (ext === '.mp4') {
                                    mimetype = 'video/mp4';
                                } else if (ext === '.avi') {
                                    mimetype = 'video/x-msvideo';
                                } else if (ext === '.mov') {
                                    mimetype = 'video/quicktime';
                                } else if (ext === '.webm') {
                                    mimetype = 'video/webm';
                                } else if (ext === '.mkv') {
                                    mimetype = 'video/x-matroska';
                                }
                                
                                // Clean filename - remove special characters that might cause issues
                                let cleanFilename = recipient.attachment.filename || path.basename(filePath);
                                // Replace problematic characters (parentheses, spaces, special chars)
                                cleanFilename = cleanFilename
                                    .replace(/[()\[\]]/g, '_')  // Remove parentheses and brackets
                                    .replace(/\s+/g, '_')       // Replace spaces with underscores
                                    .replace(/[^a-zA-Z0-9._-]/g, '_')  // Remove other special chars
                                    .replace(/_+/g, '_')        // Replace multiple underscores with single
                                    .replace(/^_+|_+$/g, '');  // Remove leading/trailing underscores
                                
                                // Ensure filename has extension
                                if (!cleanFilename.match(/\.[a-z0-9]+$/i)) {
                                    cleanFilename += ext;
                                }
                                
                                console.log(`Processing video: original="${recipient.attachment.filename}", cleaned="${cleanFilename}", size=${fileSizeMB.toFixed(2)}MB`);
                                
                                try {
                                    // First try: Use fromFilePath (most reliable for whatsapp-web.js)
                                    console.log(`Attempting to load video using fromFilePath: ${filePath}`);
                                    media = MessageMedia.fromFilePath(filePath);
                                    media.mimetype = mimetype;
                                    media.filename = cleanFilename;
                                    console.log(`Video loaded successfully using fromFilePath, MIME: ${mimetype}, filename: ${cleanFilename}`);
                                } catch (fromFilePathError) {
                                    console.error(`fromFilePath failed (${fromFilePathError.message}), trying buffer approach...`);
                                    try {
                                        // Second try: Read as buffer
                                        console.log(`Reading video file as buffer...`);
                                        const fileBuffer = fs.readFileSync(filePath);
                                        media = new MessageMedia(mimetype, fileBuffer.toString('base64'), cleanFilename);
                                        console.log(`Video loaded successfully using buffer, MIME: ${mimetype}, filename: ${cleanFilename}, size: ${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB`);
                                    } catch (bufferError) {
                                        console.error(`Buffer approach also failed:`, bufferError.message);
                                        throw new Error(`Failed to load video file: ${bufferError.message}`);
                                    }
                                }
                            } else {
                                // For images and documents, use fromFilePath
                                media = MessageMedia.fromFilePath(filePath);
                                
                                // Set filename and mimetype based on attachment type
                                if (recipient.attachment.filename) {
                                    media.filename = recipient.attachment.filename;
                                }
                                
                                // Set mimetype based on file extension
                                const ext = path.extname(recipient.attachment.filename || filePath).toLowerCase();
                                if (recipient.attachment.type === 'image') {
                                    if (ext === '.jpg' || ext === '.jpeg') {
                                        media.mimetype = 'image/jpeg';
                                    } else if (ext === '.png') {
                                        media.mimetype = 'image/png';
                                    } else if (ext === '.gif') {
                                        media.mimetype = 'image/gif';
                                    } else if (ext === '.webp') {
                                        media.mimetype = 'image/webp';
                                    }
                                } else if (recipient.attachment.type === 'document') {
                                    if (ext === '.pdf') {
                                        media.mimetype = 'application/pdf';
                                    } else if (ext === '.doc' || ext === '.docx') {
                                        media.mimetype = 'application/msword';
                                    } else if (ext === '.xls' || ext === '.xlsx') {
                                        media.mimetype = 'application/vnd.ms-excel';
                                    } else {
                                        media.mimetype = 'application/octet-stream';
                                    }
                                }
                            }
                            
                            console.log(`Sending media message with caption: ${recipient.message || '(no caption)'}`);
                            
                            // Send media message with caption
                            const sendOptions = {
                                caption: recipient.message || '',
                            };
                            
                            // For videos, try sending as video first (for inline play), fallback to document if it fails
                            if (recipient.attachment.type === 'video') {
                                // WhatsApp has a 16MB limit for videos sent as video
                                // For larger files, send as document
                                if (fileSizeMB > 16) {
                                    console.log(`Video file is ${fileSizeMB.toFixed(2)} MB, sending as document (exceeds 16MB limit)`);
                                    sendOptions.sendMediaAsDocument = true;
                                } else {
                                    // Try as video first for inline play
                                    sendOptions.sendMediaAsDocument = false;
                                    console.log(`Attempting to send video as video for inline play (file: ${fileSizeMB.toFixed(2)} MB)`);
                                }
                            }
                            
                            try {
                                console.log(`Sending ${recipient.attachment.type} message to ${chatId}, asDocument: ${sendOptions.sendMediaAsDocument || false}`);
                                await client.sendMessage(chatId, media, sendOptions);
                                console.log(`Successfully sent ${recipient.attachment.type} message to ${chatId}`);
                            } catch (sendError) {
                                console.error(`Error sending ${recipient.attachment.type} message:`, sendError.message);
                                console.error(`Error stack:`, sendError.stack);
                                
                                // For videos, if sending as video fails, try as document
                                if (recipient.attachment.type === 'video' && !sendOptions.sendMediaAsDocument) {
                                    const errorMsg = sendError.message || '';
                                    const isPuppeteerError = errorMsg.includes('Evaluation failed') || 
                                                           errorMsg.includes('Session closed') ||
                                                           errorMsg.includes('Protocol error');
                                    
                                    if (isPuppeteerError) {
                                        console.log(`Puppeteer error detected (${errorMsg}), retrying as document...`);
                                    } else {
                                        console.log(`Video sending failed (${errorMsg}), retrying as document...`);
                                    }
                                    
                                    // Retry as document
                                    sendOptions.sendMediaAsDocument = true;
                                    try {
                                        await client.sendMessage(chatId, media, sendOptions);
                                        console.log(`Successfully sent video as document to ${chatId} (fallback after video send failed)`);
                                    } catch (documentError) {
                                        console.error(`Failed to send as document too:`, documentError.message);
                                        throw new Error(`Failed to send video file. Video send failed: ${sendError.message}. Document fallback also failed: ${documentError.message}`);
                                    }
                                } else {
                                    throw sendError;
                                }
                            }
                            
                            console.log(`Media message sent successfully for recipient ${recipient.id}`);
                        } catch (mediaError) {
                            console.error(`Error sending media for recipient ${recipient.id}:`, mediaError);
                            console.error(`Error details:`, {
                                message: mediaError.message,
                                stack: mediaError.stack,
                                path: recipient.attachment?.path,
                                type: recipient.attachment?.type,
                            });
                            // Fallback to text message if media fails
                            try {
                                await client.sendMessage(chatId, recipient.message || 'Message with attachment (attachment failed to send)');
                            } catch (textError) {
                                console.error(`Failed to send fallback text message:`, textError);
                            }
                            throw mediaError;
                        }
                    } else {
                        // Send text message only
                        await client.sendMessage(chatId, recipient.message);
                    }
                    
                    return {
                        id: recipient.id,
                        success: true,
                        error: null,
                    };
                } catch (error) {
                    return {
                        id: recipient.id,
                        success: false,
                        error: error.message || 'Unknown error',
                    };
                }
            })
        );
        
        // Process results
        batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                results.push({
                    id: batch[index].id,
                    success: false,
                    error: result.reason?.message || 'Unknown error',
                });
            }
        });
        
        // Delay between batches
        if (i + CONCURRENT_MESSAGES < recipients.length) {
            await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
        }
    }
    
    // Update counter
    const successCount = results.filter(r => r.success).length;
    updateCounter(userIdStr, successCount);
    
    return results;
}

// Logout session
function logoutSession(userId) {
    const userIdStr = String(userId);
    if (userSessions.has(userIdStr)) {
        const session = userSessions.get(userIdStr);
        if (session.client) {
            session.client.logout().catch(error => {
                console.error(`Error logging out user ${userIdStr}:`, error);
            });
        }
        userSessions.delete(userIdStr);
    }
    // Clear reinit attempts on logout
    reinitAttempts.delete(userIdStr);
}

// HTTP Server
const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Content-Type', 'application/json');
    
    // Handle OPTIONS request
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Check API key (optional, can be removed if not needed)
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey !== API_KEY) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid API key' }));
        return;
    }
    
    // Session endpoint
    if (req.method === 'GET' && url.pathname === '/session') {
        const userId = String(url.searchParams.get('userId') || 'default');
        console.log(`Session status check for user: ${userId}`);
        const status = getSessionStatus(userId);
        res.writeHead(200);
        res.end(JSON.stringify(status));
        return;
    }
    
    // Send bulk endpoint
    if (req.method === 'POST' && url.pathname === '/send-bulk') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const userId = String(data.userId || 'default'); // Ensure userId is a string
                const recipients = data.recipients || [];
                
                console.log(`Send bulk request for user: ${userId}, recipients: ${recipients.length}`);
                
                if (!Array.isArray(recipients) || recipients.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid recipients data' }));
                    return;
                }
                
                const results = await sendBulkMessages(recipients, userId);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    results: results,
                }));
            } catch (error) {
                console.error('Send bulk error:', error);
                res.writeHead(500);
                res.end(JSON.stringify({
                    success: false,
                    error: error.message,
                }));
            }
        });
        return;
    }
    
    // Logout endpoint
    if (req.method === 'POST' && url.pathname === '/logout') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const userId = data.userId || 'default';
                logoutSession(userId);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: 'Session logged out successfully',
                }));
            } catch (error) {
                res.writeHead(500);
                res.end(JSON.stringify({
                    success: false,
                    error: error.message,
                }));
            }
        });
        return;
    }
    
    // Reset endpoint - clears error state and allows fresh start
    if (req.method === 'POST' && url.pathname === '/reset') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const userId = String(data.userId || 'default');
                const userIdStr = String(userId);
                
                console.log(`Resetting session for user ${userIdStr}...`);
                
                // Clear session from memory
                if (userSessions.has(userIdStr)) {
                    const session = userSessions.get(userIdStr);
                    if (session.client) {
                        try {
                            session.client.destroy().catch(e => {
                                console.log(`Error destroying client during reset: ${e.message}`);
                            });
                        } catch (e) {
                            console.log(`Error destroying client during reset: ${e.message}`);
                        }
                    }
                    userSessions.delete(userIdStr);
                }
                
                // Clear reinit attempts counter
                reinitAttempts.delete(userIdStr);
                console.log(`Cleared reinit attempts for user ${userIdStr}`);
                
                // Delete session files to start completely fresh
                const sessionPath = path.join(__dirname, 'sessions', `session_${userIdStr}`);
                try {
                    if (fs.existsSync(sessionPath)) {
                        // Delete entire session directory
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                        console.log(`Deleted session files for user ${userIdStr} at ${sessionPath}`);
                    }
                } catch (fsError) {
                    console.error(`Error deleting session files for user ${userIdStr}:`, fsError.message);
                    // Continue anyway - we'll try to initialize with existing files
                }
                
                // Initialize fresh session
                console.log(`Initializing fresh session for user ${userIdStr}...`);
                initializeClient(userIdStr);
                
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    message: 'Session reset successfully. Initializing...',
                }));
            } catch (error) {
                console.error(`Error in reset endpoint for user ${data?.userId}:`, error);
                res.writeHead(500);
                res.end(JSON.stringify({
                    success: false,
                    error: error.message,
                }));
            }
        });
        return;
    }
    
    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            timestamp: new Date().toISOString(),
        }));
        return;
    }
    
    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
});

// Start server
server.listen(PORT, () => {
    console.log(`WhatsApp service running on port ${PORT}`);
    console.log(`CORS origin: ${CORS_ORIGIN}`);
    
    // Reset counters daily
    resetDailyCounters();
    
    // Reset counters at midnight
    setInterval(() => {
        resetDailyCounters();
    }, 60 * 60 * 1000); // Check every hour
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

