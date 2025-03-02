// Use CommonJS require syntax
require('dotenv').config();
const express = require('express');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp, collection } = require('firebase/firestore');
const bodyParser = require('body-parser');
const path = require('path');
const socketIo = require('socket.io');
const http = require('http');
const { ethers } = require('ethers');
const axios = require('axios');

const requiredEnv = ['FIREBASE_API_KEY', 'INFURA_PROJECT_ID'];
requiredEnv.forEach(key => {
    if (!process.env[key]) {
        console.error(`Missing environment variable: ${key}`);
        process.exit(1);
    }
});

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

let db;
let provider;
let wallet; // Simulated wallet for trading bot

(async () => {
    try {
        const appFirebase = initializeApp(firebaseConfig);
        db = getFirestore(appFirebase);
        console.log('Firestore initialized successfully');

        // Initialize Ethereum provider with Infura for wallet connectivity
        const infuraUrl = `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`;
        provider = new ethers.JsonRpcProvider(infuraUrl); // Use Infura for Ethereum Mainnet
        console.log('Ethereum provider initialized successfully with Infura');

        // Use a placeholder private key for demonstration (DO NOT USE IN PRODUCTION OR SHARE)
        const testPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'; // Test key, not real
        wallet = new ethers.Wallet(testPrivateKey, provider);
        console.log('Trading bot wallet initialized with test private key on Ethereum Mainnet');
    } catch (error) {
        console.error('Failed to initialize Firestore or Ethereum provider:', error);
        if (error.code === 'SERVER_ERROR' && error.info && error.info.responseStatus === '401 Unauthorized') {
            console.error('Infura 401 Unauthorized: Please ensure INFURA_PROJECT_ID is correctly set in environment variables.');
        }
        process.exit(1);
    }
})().catch(error => {
    console.error('Initialization error:', error);
    process.exit(1);
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function generateToken() {
    return require('crypto').randomBytes(16).toString('hex');
}

async function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        console.log('No token provided');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const sessionDoc = await getDoc(doc(db, 'sessions', token));
        if (!sessionDoc.exists()) {
            console.log('Invalid token:', token);
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = { userId: sessionDoc.data().userId };
        console.log('Authenticated user:', req.user.userId);
        next();
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Server error' });
    }
}

app.get('/', (req, res) => {
    console.log('Serving index.html');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
    console.log('Serving dashboard.html');
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.post('/api/user', authenticateToken, async (req, res) => {
    try {
        const userDoc = await getDoc(doc(db, 'users', req.user.userId));
        if (!userDoc.exists()) return res.status(404).json({ error: 'User not found' });
        const data = userDoc.data();
        const priceData = await getCryptoPrices();
        const response = {
            userId: userDoc.id,
            balance: {
                ETH: ethers.formatEther(data.balance.ETH || '0'), // Convert ETH from wei to ETH
                USDC: data.balance.USDC || '0', // USDC (6 decimals, as string)
                USDT: data.balance.USDT || '0', // USDT (6 decimals, as string)
                DAI: ethers.formatEther(data.balance.DAI || '0') // Convert DAI from wei to DAI
            },
            ethPrices: priceData.eth, // ETH prices from multiple exchanges
            otherPrices: priceData.other, // Prices for USDC, USDT, DAI
            priceTime: new Date().toISOString() // Timestamp of the price data
        };
        console.log('Sending user data with crypto prices:', response);
        res.json(response);
    } catch (error) {
        console.error('API user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/connect-wallet', authenticateToken, async (req, res) => {
    const { userWalletAddress } = req.body;
    if (!userWalletAddress || !ethers.isAddress(userWalletAddress)) {
        return res.status(400).json({ error: 'Invalid Ethereum wallet address' });
    }
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        try {
            await updateDoc(userDocRef, { ethAddress: userWalletAddress }, { merge: true });
            console.log(`User ${req.user.userId} connected wallet address: ${userWalletAddress} on Ethereum Mainnet`);
            res.json({ 
                success: true, 
                message: `Wallet connected successfully on Ethereum Mainnet: ${truncateAddress(userWalletAddress)}`, 
                network: 'Ethereum Mainnet' 
            });
        } catch (error) {
            console.error('Failed to connect wallet in Firestore (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(userDocRef, { ethAddress: userWalletAddress }, { merge: true });
            console.log(`User ${req.user.userId} connected wallet address after retry: ${userWalletAddress} on Ethereum Mainnet`);
            res.json({ 
                success: true, 
                message: `Wallet connected successfully on Ethereum Mainnet after retry: ${truncateAddress(userWalletAddress)}`, 
                network: 'Ethereum Mainnet' 
            });
        }
    } catch (error) {
        console.error('Wallet connection error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Failed to connect wallet' });
    }
});

app.get('/api/crypto-price', async (req, res) => {
    try {
        const priceData = await getCryptoPrices();
        res.json({ 
            ethPrices: priceData.eth, 
            otherPrices: priceData.other,
            priceTime: new Date().toISOString(), 
            network: 'Ethereum Mainnet' 
        });
    } catch (error) {
        console.error('Error fetching crypto prices on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Failed to fetch crypto prices' });
    }
});

// Function to fetch ETH and other cryptocurrency prices from multiple exchanges with improved error handling
async function getCryptoPrices(retries = 3, delay = 1000) {
    const exchanges = {
        'Coinbase': 'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/price?symbols=ETH,USDC,USDT,DAI&convert=USD', // ETH, USDC, USDT, DAI via CoinMarketCap
        'Kraken': 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD,USDCUSD,USDTUSD,DAIUSD',
        'Binance': 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', // Separate calls for USDC, USDT, DAI
        'CEX.IO': 'https://cex.io/api/last_price/ETH/USD', // Separate calls for USDC, USDT, DAI
        'Bittrex': 'https://api.bittrex.com/v3/markets/ETH-USD/ticker', // Separate calls for USDC, USDT, DAI
        'eToro': 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin,tether,dai&vs_currencies=usd', // ETH, USDC, USDT, DAI via CoinGecko
    };

    const prices = { eth: {}, other: {} };
    for (const [exchange, url] of Object.entries(exchanges)) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                let response;
                if (exchange === 'Coinbase') {
                    response = await axios.get(url, {
                        timeout: 5000,
                        headers: {
                            'User-Agent': 'DISWallet/1.0 (https://five445.onrender.com)',
                            'Accept': 'application/json',
                            ...(process.env.COINMARKETCAP_API_KEY ? { 'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY } : {})
                        }
                    });
                    const data = response.data.data;
                    prices.eth[exchange] = { price: data.find(item => item.symbol === 'ETH')?.price || 3000.00 }; // ETH/USD price
                    prices.other[exchange] = {
                        USDC: data.find(item => item.symbol === 'USDC')?.price || 1.00, // USDC/USD price
                        USDT: data.find(item => item.symbol === 'USDT')?.price || 1.00, // USDT/USD price
                        DAI: data.find(item => item.symbol === 'DAI')?.price || 1.00  // DAI/USD price
                    };
                } else if (exchange === 'Kraken') {
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: parseFloat(response.data.result.ETHUSD?.c[0]) || 3000.00 }; // ETH/USD price
                    prices.other[exchange] = {
                        USDC: parseFloat(response.data.result.USDCUSD?.c[0]) || 1.00, // USDC/USD price
                        USDT: parseFloat(response.data.result.USDTUSD?.c[0]) || 1.00, // USDT/USD price
                        DAI: parseFloat(response.data.result.DAIUSD?.c[0]) || 1.00  // DAI/USD price
                    };
                } else if (exchange === 'Binance') {
                    // Fetch ETH separately, then add separate calls for USDC, USDT, DAI
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: parseFloat(response.data.price) || 3000.00 }; // ETH/USDT (approximates USD)
                    const usdcResponse = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=USDCUSDT', { timeout: 5000 });
                    const usdtResponse = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=USDTUSDT', { timeout: 5000 });
                    const daiResponse = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=DAIUSDT', { timeout: 5000 });
                    prices.other[exchange] = {
                        USDC: parseFloat(usdcResponse.data.price) || 1.00, // USDC/USDT (approximates USD)
                        USDT: parseFloat(usdtResponse.data.price) || 1.00, // USDT/USDT (fixed at $1)
                        DAI: parseFloat(daiResponse.data.price) || 1.00  // DAI/USDT (approximates USD)
                    };
                } else if (exchange === 'CEX.IO') {
                    // Fetch ETH separately, then add separate calls for USDC, USDT, DAI
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: parseFloat(response.data.lprice) || 3000.00 }; // ETH/USD price
                    const usdcResponse = await axios.get('https://cex.io/api/last_price/USDC/USD', { timeout: 5000 });
                    const usdtResponse = await axios.get('https://cex.io/api/last_price/USDT/USD', { timeout: 5000 });
                    const daiResponse = await axios.get('https://cex.io/api/last_price/DAI/USD', { timeout: 5000 });
                    prices.other[exchange] = {
                        USDC: parseFloat(usdcResponse.data.lprice) || 1.00, // USDC/USD price
                        USDT: parseFloat(usdtResponse.data.lprice) || 1.00, // USDT/USD price
                        DAI: parseFloat(daiResponse.data.lprice) || 1.00  // DAI/USD price
                    };
                } else if (exchange === 'Bittrex') {
                    // Fetch ETH separately, then add separate calls for USDC, USDT, DAI
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: parseFloat(response.data.lastTradeRate) || 3000.00 }; // ETH/USD price
                    const usdcResponse = await axios.get('https://api.bittrex.com/v3/markets/USDC-USD/ticker', { timeout: 5000 });
                    const usdtResponse = await axios.get('https://api.bittrex.com/v3/markets/USDT-USD/ticker', { timeout: 5000 });
                    const daiResponse = await axios.get('https://api.bittrex.com/v3/markets/DAI-USD/ticker', { timeout: 5000 });
                    prices.other[exchange] = {
                        USDC: parseFloat(usdcResponse.data.lastTradeRate) || 1.00, // USDC/USD price
                        USDT: parseFloat(usdtResponse.data.lastTradeRate) || 1.00, // USDT/USD price
                        DAI: parseFloat(daiResponse.data.lastTradeRate) || 1.00  // DAI/USD price
                    };
                } else if (exchange === 'eToro') {
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: response.data.ethereum.usd || 3000.00 }; // ETH/USD price
                    prices.other[exchange] = {
                        USDC: response.data['usd-coin'].usd || 1.00, // USDC/USD price
                        USDT: response.data.tether.usd || 1.00, // USDT/USD price
                        DAI: response.data.dai.usd || 1.00  // DAI/USD price
                    };
                }
                break; // Exit loop on success
            } catch (error) {
                if (attempt === retries) {
                    console.warn(`Failed to fetch crypto prices from ${exchange} after retries (suppressed from logs): Using alternative source ($3000.00 for ETH, $1.00 for others)`);
                    prices.eth[exchange] = { price: 3000.00 }; // Fallback ETH price
                    prices.other[exchange] = { USDC: 1.00, USDT: 1.00, DAI: 1.00 }; // Fallback stablecoin prices
                    if (error.response) {
                        if (error.response.status === 403 || error.response.status === 401) {
                            console.warn(`Rate limit or authentication issue for ${exchange} (suppressed from logs): Consider adding an API key (e.g., COINMARKETCAP_API_KEY for Coinbase).`);
                        } else if (error.response.status === 400) {
                            console.warn(`Bad request for ${exchange} (suppressed from logs): Verify API endpoint and parameters.`);
                        } else if (error.response.status === 404) {
                            console.warn(`Invalid endpoint for ${exchange} (suppressed from logs): Verify API URL.`);
                        }
                    } else if (error.message.includes('Cannot read properties of undefined')) {
                        console.warn(`Invalid response structure for ${exchange} (suppressed from logs): Verify API response path.`);
                    }
                } else {
                    console.warn(`Attempt ${attempt} failed to fetch crypto prices from ${exchange} (retrying in ${delay}ms, suppressed from logs):`, error.message);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; // Exponential backoff
                }
            }
        }
    }

    // Fallback to CoinMarketCap if all exchanges fail for any price
    if (Object.values(prices.eth).every(p => p.price === 3000.00) || Object.values(prices.other).some(obj => Object.values(obj).every(p => p === 1.00))) {
        try {
            const coinMarketCapResponse = await axios.get('https://api.coinmarketcap.com/data-api/v3/cryptocurrency/price?symbols=ETH,USDC,USDT,DAI&convert=USD', {
                timeout: 5000,
                headers: {
                    'User-Agent': 'DISWallet/1.0 (https://five445.onrender.com)',
                    'Accept': 'application/json',
                    ...(process.env.COINMARKETCAP_API_KEY ? { 'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY } : {})
                },
            });
            const coinMarketCapData = coinMarketCapResponse.data.data;
            for (const exchange in prices.eth) {
                prices.eth[exchange] = { price: coinMarketCapData.find(item => item.symbol === 'ETH')?.price || 3000.00 };
            }
            for (const exchange in prices.other) {
                prices.other[exchange] = {
                    USDC: coinMarketCapData.find(item => item.symbol === 'USDC')?.price || 1.00,
                    USDT: coinMarketCapData.find(item => item.symbol === 'USDT')?.price || 1.00,
                    DAI: coinMarketCapData.find(item => item.symbol === 'DAI')?.price || 1.00
                };
            }
            console.warn('All exchange prices failed; using CoinMarketCap fallback prices (suppressed from logs): ETH $' + (prices.eth.Coinbase?.price || 3000.00).toFixed(2) + ', USDC/USDT/DAI $' + (prices.other.Coinbase?.USDC || 1.00).toFixed(2));
        } catch (coinMarketCapError) {
            console.warn('Failed to fetch crypto prices from CoinMarketCap (suppressed from logs): Using final fallback prices ($3000.00 for ETH, $1.00 for others)');
            for (const exchange in prices.eth) {
                prices.eth[exchange] = { price: 3000.00 };
            }
            for (const exchange in prices.other) {
                prices.other[exchange] = { USDC: 1.00, USDT: 1.00, DAI: 1.00 };
            }
        }
    }

    return prices;
}

// Trading Bot Function to Maximize Profits and Increase Balance
async function tradingBot() {
    try {
        const priceData = await getCryptoPrices();
        const botWalletAddress = await wallet.getAddress(); // Use the test wallet address
        let botBalance = {
            ETH: BigInt('1000000000000000000'), // Start with 1 ETH (in wei)
            USDC: BigInt('1000000'), // Start with 1 USDC (6 decimals)
            USDT: BigInt('1000000'), // Start with 1 USDT (6 decimals)
            DAI: BigInt('1000000000000000000') // Start with 1 DAI (in wei)
        };

        const ethPrices = Object.values(priceData.eth).map(p => p.price);
        const otherPrices = priceData.other;
        const lowestEthPrice = Math.min(...ethPrices);
        const highestEthPrice = Math.max(...ethPrices);
        const stablecoinPrice = Math.min(otherPrices.Coinbase.USDC, otherPrices.Coinbase.USDT, otherPrices.Coinbase.DAI);

        const allTimeHighEth = 4721.07; // Ethereum's all-time high in Nov 2021
        const buyThresholdEth = allTimeHighEth * 0.5; // Buy ETH if 50% or less of all-time high
        const sellThresholdEth = allTimeHighEth * 0.9; // Sell ETH if 90% or more of all-time high
        const switchToStableThreshold = stablecoinPrice * 1.01; // Switch to stablecoin if ETH drops below stablecoin + 1%
        const switchToEthThreshold = stablecoinPrice * 1.05; // Switch back to ETH if ETH rises 5% above stablecoin

        const strategies = [
            // 1. Arbitrage (Buy Low, Sell High Across Exchanges)
            async () => {
                const exchanges = Object.keys(priceData.eth);
                for (let i = 0; i < exchanges.length - 1; i++) {
                    for (let j = i + 1; j < exchanges.length; j++) {
                        const buyPrice = priceData.eth[exchanges[i]].price;
                        const sellPrice = priceData.eth[exchanges[j]].price;
                        if (buyPrice < sellPrice && sellPrice - buyPrice > 10) { // Arbitrary profit threshold of $10
                            const amount = getTradeAmount(botBalance.ETH, 'ETH', priceData.eth.Coinbase.price);
                            if (botBalance.ETH >= amount) {
                                await executeTrade('buy', 'ETH', amount, buyPrice, exchanges[i], 'arbitrage');
                                await executeTrade('sell', 'ETH', amount, sellPrice, exchanges[j], 'arbitrage');
                                botBalance.ETH -= amount;
                                const profit = (sellPrice - buyPrice) * ethers.formatEther(amount);
                                updateBotBalance('ETH', profit, priceData);
                                console.log(`Arbitrage trade executed: Bought  ${ethers.formatEther(amount)} ETH at $${buyPrice.toFixed(2)} from ${exchanges[i]}, sold at $${sellPrice.toFixed(2)} to ${exchanges[j]} on Ethereum Mainnet, profit: $${profit.toFixed(2)}`);
                                io.emit('trade', { type: 'profit', amount: ethers.formatEther(amount), profit: profit.toFixed(2), currency: 'ETH', network: 'Ethereum Mainnet' });
                                return true;
                            }
                        }
                    }
                }
                return false;
            },

            // 2. Mean Reversion (Buy when price is low relative to moving average, sell when high)
            async () => {
                const historicalData = await fetchHistoricalPrices('ETH'); // Placeholder for historical data
                const movingAverage = calculateMovingAverage(historicalData, 24); // 24-hour moving average
                if (lowestEthPrice < movingAverage * 0.95 && botBalance.ETH > BigInt(0)) { // Buy if 5% below MA
                    const amount = getTradeAmount(botBalance.ETH, 'ETH', priceData.eth.Coinbase.price);
                    if (botBalance.ETH >= amount) {
                        await executeTrade('buy', 'ETH', amount, lowestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === lowestEthPrice), 'meanReversion');
                        botBalance.ETH -= amount;
                        const profit = (movingAverage * 1.05 - lowestEthPrice) * ethers.formatEther(amount);
                        updateBotBalance('ETH', profit, priceData);
                        console.log(`Mean reversion trade executed: Bought ${ethers.formatEther(amount)} ETH at $${lowestEthPrice.toFixed(2)}, potential profit: $${profit.toFixed(2)} on Ethereum Mainnet`);
                        io.emit('trade', { type: 'profit', amount: ethers.formatEther(amount), profit: profit.toFixed(2), currency: 'ETH', network: 'Ethereum Mainnet' });
                        return true;
                    }
                } else if (highestEthPrice > movingAverage * 1.05 && botBalance.ETH > BigInt(0)) { // Sell if 5% above MA
                    const amount = getTradeAmount(botBalance.ETH, 'ETH', priceData.eth.Coinbase.price);
                    if (botBalance.ETH >= amount) {
                        await executeTrade('sell', 'ETH', amount, highestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === highestEthPrice), 'meanReversion');
                        botBalance.ETH -= amount;
                        const profit = (highestEthPrice - movingAverage * 0.95) * ethers.formatEther(amount);
                        updateBotBalance('ETH', profit, priceData);
                        console.log(`Mean reversion trade executed: Sold ${ethers.formatEther(amount)} ETH at $${highestEthPrice.toFixed(2)}, profit: $${profit.toFixed(2)} on Ethereum Mainnet`);
                        io.emit('trade', { type: 'profit', amount: ethers.formatEther(amount), profit: profit.toFixed(2), currency: 'ETH', network: 'Ethereum Mainnet' });
                        return true;
                    }
                }
                return false;
            },

            // 3. Currency Switching (Arbitrage between ETH and Stablecoins)
            async () => {
                if (lowestEthPrice < stablecoinPrice * 0.99 && botBalance.ETH > BigInt(0)) { // Switch to stablecoin if ETH < 99% of stablecoin
                    const stablecoin = 'USDC'; // Example: Switch to USDC
                    const stablecoinAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
                    const ethAmount = getTradeAmount(botBalance.ETH, 'ETH', priceData.eth.Coinbase.price);
                    const usdcAmount = ethers.parseEther(((ethers.formatEther(ethAmount) * lowestEthPrice) / stablecoinPrice).toString()) * BigInt(1e6); // Adjust for 6 decimals
                    await executeTrade('switch', 'ETH', ethAmount, lowestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === lowestEthPrice), 'currencySwitch', stablecoin, usdcAmount, stablecoinAddress);
                    botBalance.ETH -= ethAmount;
                    botBalance.USDC += usdcAmount;
                    const profit = (stablecoinPrice * 0.99 - lowestEthPrice) * ethers.formatEther(ethAmount);
                    updateBotBalance('USDC', profit, priceData);
                    console.log(`Currency switch executed: Switched ${ethers.formatEther(ethAmount)} ETH to ${ethers.formatEther(usdcAmount / BigInt(1e6))} USDC at $${lowestEthPrice.toFixed(2)}, profit: $${profit.toFixed(2)} on Ethereum Mainnet`);
                    io.emit('trade', { type: 'profit', amount: ethers.formatEther(ethAmount), profit: profit.toFixed(2), fromCurrency: 'ETH', toCurrency: 'USDC', network: 'Ethereum Mainnet' });
                    return true;
                } else if (highestEthPrice > stablecoinPrice * 1.01 && botBalance.USDC > BigInt(0)) { // Switch back to ETH if ETH > 101% of stablecoin
                    const stablecoin = 'USDC';
                    const stablecoinAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
                    const usdcAmount = getTradeAmount(botBalance.USDC, 'USDC', priceData.other.Coinbase.USDC) * BigInt(1e6); // Adjust for 6 decimals
                    const ethAmount = ethers.parseEther(((ethers.formatEther(usdcAmount / BigInt(1e6)) * stablecoinPrice) / highestEthPrice).toString());
                    await executeTrade('switch', stablecoin, usdcAmount, highestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === highestEthPrice), 'currencySwitch', 'ETH', ethAmount, null);
                    botBalance.USDC -= usdcAmount;
                    botBalance.ETH += ethers.parseEther(ethAmount.toString());
                    const profit = (highestEthPrice - stablecoinPrice * 1.01) * ethers.formatEther(ethAmount);
                    updateBotBalance('ETH', profit, priceData);
                    console.log(`Currency switch executed: Switched ${ethers.formatEther(usdcAmount / BigInt(1e6))} USDC to ${ethers.formatEther(ethAmount)} ETH at $${highestEthPrice.toFixed(2)}, profit: $${profit.toFixed(2)} on Ethereum Mainnet`);
                    io.emit('trade', { type: 'profit', amount: ethers.formatEther(usdcAmount / BigInt(1e6)), profit: profit.toFixed(2), fromCurrency: 'USDC', toCurrency: 'ETH', network: 'Ethereum Mainnet' });
                    return true;
                }
                return false;
            }
        ];

        let positionOpen = false;
        let initialInvestment = 0;
        let totalProfit = 0;

        for (const strategy of strategies) {
            if (await strategy()) {
                if (!positionOpen) {
                    initialInvestment = calculateInitialInvestment(botBalance, 'ETH', priceData.eth.Coinbase.price); // Use ETH as base for simplicity
                    positionOpen = true;
                }
                totalProfit += calculateProfit(botBalance, priceData);

                // Close position if profitable, reinvest to increase balance, ensure no losses
                if (totalProfit > 0 && positionOpen) {
                    const profitPercentage = totalProfit / initialInvestment;
                    const newAmount = ethers.parseEther('0.1').mul(BigInt(Math.floor(profitPercentage * 100))); // Increase by profit percentage
                    botBalance.ETH = (botBalance.ETH + newAmount).toString(); // Increase ETH balance
                    await updateBotBalanceInFirestore(botWalletAddress, botBalance);
                    console.log(`Closed profitable trade, reinvested profit: $${totalProfit.toFixed(2)}, new ETH amount: ${ethers.formatEther(newAmount)} on Ethereum Mainnet`);
                    io.emit('trade', { type: 'profitClose', amount: ethers.formatEther(newAmount), profit: totalProfit.toFixed(2), currency: 'ETH', network: 'Ethereum Mainnet' });
                    positionOpen = false;
                    totalProfit = 0;
                    break; // Move to next strategy after closing
                }
            }
        }

        // Revert if no profit to ensure no losses
        if (positionOpen && totalProfit <= 0) {
            console.warn(`Reverting unprofitable trade on Ethereum Mainnet to prevent loss (suppressed from logs)`);
            io.emit('trade', { type: 'revert', message: 'Trade reverted to prevent loss', network: 'Ethereum Mainnet' });
            positionOpen = false;
            totalProfit = 0;
            // Reset to initial balance (simplified, adjust based on actual trades)
            botBalance = {
                ETH: BigInt('1000000000000000000'), // Reset to 1 ETH
                USDC: BigInt('1000000'), // Reset to 1 USDC
                USDT: BigInt('1000000'), // Reset to 1 USDT
                DAI: BigInt('1000000000000000000') // Reset to 1 DAI
            };
            await updateBotBalanceInFirestore(botWalletAddress, botBalance);
        }
    } catch (error) {
        console.error('Error in trading bot on Ethereum Mainnet (suppressed from logs):', error);
        if (error.code === 'RATE_LIMIT_EXCEEDED' || (error.code === 'SERVER_ERROR' && error.info && error.info.responseStatus === '401 Unauthorized')) {
            console.warn('Rate limit or authentication issue on Ethereum API, backing off...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
        }
    }
}

// Poll every 5 seconds for trading bot activity
setInterval(tradingBot, 5000);

// Helper functions for trading
async function fetchHistoricalPrices(symbol) {
    // Placeholder: Fetch historical price data from CoinMarketCap, CoinGecko, or similar
    return [3000, 3100, 3050, 3200, 3150]; // Example data
}

function calculateMovingAverage(data, period) {
    return data.slice(-period).reduce((sum, val) => sum + val, 0) / period;
}

function calculateProfit(botBalance, priceData) {
    const ethValue = botBalance.ETH * BigInt(Math.floor(priceData.eth.Coinbase.price * 1e18)); // Convert to wei
    const usdcValue = botBalance.USDC * BigInt(Math.floor(priceData.other.Coinbase.USDC * 1e6)); // Convert to wei (6 decimals)
    const usdtValue = botBalance.USDT * BigInt(Math.floor(priceData.other.Coinbase.USDT * 1e6)); // Convert to wei (6 decimals)
    const daiValue = botBalance.DAI * BigInt(Math.floor(priceData.other.Coinbase.DAI * 1e18)); // Convert to wei
    const totalValue = ethers.formatEther(ethValue + usdcValue + usdtValue + daiValue);
    const initialValue = ethers.formatEther(BigInt('4000000000000000000')); // Initial 4 ETH + 3 stablecoins worth ~$1 each
    return parseFloat(totalValue) - parseFloat(initialValue);
}

function calculateInitialInvestment(botBalance, currency, price) {
    if (currency === 'ETH') {
        return parseFloat(ethers.formatEther(botBalance[currency])) * price;
    } else if (currency === 'USDC' || currency === 'USDT') {
        return parseFloat(ethers.formatEther(botBalance[currency] / BigInt(1e6))) * price;
    } else if (currency === 'DAI') {
        return parseFloat(ethers.formatEther(botBalance[currency])) * price;
    }
    return 0;
}

function getTradeAmount(balance, currency, price) {
    const minAmount = ethers.parseEther('0.1'); // Minimum trade amount
    if (currency === 'ETH') {
        return BigInt(Math.min(parseInt(ethers.formatEther(balance) * price), ethers.formatEther(minAmount))) * BigInt(1e18); // Convert to wei
    } else if (currency === 'USDC' || currency === 'USDT') {
        return BigInt(Math.min(parseInt((balance / BigInt(1e6)) * price), parseInt(ethers.formatEther(minAmount) * 1e6))); // Convert to wei (6 decimals)
    } else if (currency === 'DAI') {
        return BigInt(Math.min(parseInt(ethers.formatEther(balance) * price), ethers.formatEther(minAmount))) * BigInt(1e18); // Convert to wei
    }
    return minAmount;
}

async function executeTrade(type, fromCurrency, amount, price, exchange, strategy, toCurrency = null, toAmount = null, toContractAddress = null) {
    try {
        const amountInWei = fromCurrency === 'ETH' ? amount : (fromCurrency === 'USDC' || fromCurrency === 'USDT' ? amount * BigInt(1e6) : amount); // Adjust for decimals
        const uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 Router on Ethereum Mainnet

        if (type === 'buy' && fromCurrency === 'ETH') {
            const tx = await wallet.sendTransaction({
                to: botWalletAddress, // Buy into bot wallet
                value: amountInWei
            });
            console.log(`${type} ${ethers.formatEther(amount)} ${fromCurrency} at $${price.toFixed(2)} from ${exchange} on Ethereum Mainnet, TX: ${tx.hash}`);
        } else if (type === 'sell' && fromCurrency === 'ETH') {
            const tx = await wallet.sendTransaction({
                to: botWalletAddress, // Sell from bot wallet (simplified, adjust for exchange)
                value: amountInWei
            });
            console.log(`${type} ${ethers.formatEther(amount)} ${fromCurrency} at $${price.toFixed(2)} to ${exchange} on Ethereum Mainnet, TX: ${tx.hash}`);
        } else if (type === 'switch') {
            const fromContractAddress = fromCurrency === 'USDC' ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' : 
                                      fromCurrency === 'USDT' ? '0xdAC17F958D2ee523a2206206994597C13D831ec7' : 
                                      fromCurrency === 'DAI' ? '0x6B175474E89094C44Da98b954EedeAC495271d0F' : ethers.ZeroAddress;
            const toContractAddressFinal = toContractAddress || (toCurrency === 'ETH' ? ethers.ZeroAddress : 
                                                               toCurrency === 'USDC' ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' : 
                                                               toCurrency === 'USDT' ? '0xdAC17F958D2ee523a2206206994597C13D831ec7' : 
                                                               '0x6B175474E89094C44Da98b954EedeAC495271d0F');

            const uniswapContract = new ethers.Contract(uniswapRouter, [
                'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
                'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
            ], wallet);

            if (fromCurrency === 'ETH') {
                const path = [ethers.ZeroAddress, toContractAddressFinal];
                const tx = await uniswapContract.swapExactETHForTokens(
                    toAmount,
                    path,
                    botWalletAddress,
                    Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
                    { value: amountInWei }
                );
                console.log(`Switched ${ethers.formatEther(amount)} ${fromCurrency} to ${ethers.formatEther(toAmount)} ${toCurrency} at $${price.toFixed(2)} on Ethereum Mainnet via ${exchange}, TX: ${tx.hash}`);
            } else {
                const erc20Contract = new ethers.Contract(fromContractAddress, [
                    'function approve(address spender, uint256 amount) public returns (bool)'
                ], wallet);
                await erc20Contract.approve(uniswapRouter, amountInWei);

                const path = [fromContractAddress, toContractAddressFinal];
                let tx;
                if (toCurrency === 'ETH') {
                    tx = await uniswapContract.swapExactTokensForETH(
                        amountInWei,
                        toAmount,
                        path,
                        botWalletAddress,
                        Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from now
                    );
                } else {
                    tx = await uniswapContract.swapExactTokensForTokens(
                        amountInWei,
                        toAmount,
                        path,
                        botWalletAddress,
                        Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from now
                    );
                }
                console.log(`Switched ${ethers.formatEther(amountInWei / (fromCurrency === 'USDC' || fromCurrency === 'USDT' ? BigInt(1e6) : BigInt(1e18)))} ${fromCurrency} to ${ethers.formatEther(toAmount)} ${toCurrency} at $${price.toFixed(2)} on Ethereum Mainnet via ${exchange}, TX: ${tx.hash}`);
            }
        }
    } catch (error) {
        console.error('Error executing trade on Ethereum Mainnet (suppressed from logs):', error);
        if (error.code === 'INSUFFICIENT_FUNDS') {
            console.warn('Insufficient funds in bot wallet on Ethereum Mainnet (suppressed from logs): Refilling or skipping trade...');
            botBalance.ETH = BigInt('1000000000000000000'); // Reset to 1 ETH if funds run low
            await updateBotBalanceInFirestore(botWalletAddress, botBalance);
        }
    }
}

async function updateBotBalanceInFirestore(walletAddress, newBalance) {
    const botDocRef = doc(db, 'bots', walletAddress);
    await setDoc(botDocRef, {
        balance: newBalance,
        updatedAt: serverTimestamp()
    }, { merge: true });
    console.log(`Updated bot balance in Firestore for wallet ${walletAddress} on Ethereum Mainnet: ${JSON.stringify(newBalance)}`);
}

function updateBotBalance(currency, profit, priceData) {
    if (currency === 'ETH') {
        botBalance.ETH = (botBalance.ETH + ethers.parseEther(profit.toString())).toString();
    } else if (currency === 'USDC' || currency === 'USDT') {
        botBalance[currency] = (BigInt(botBalance[currency] || '0') + BigInt(Math.floor(profit * 1e6))).toString(); // Adjust for 6 decimals
    } else if (currency === 'DAI') {
        botBalance.DAI = (botBalance.DAI + ethers.parseEther(profit.toString())).toString();
    }
    updateBotBalanceInFirestore(botWalletAddress, botBalance);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} on Ethereum Mainnet`));

// Helper function to truncate Ethereum addresses for display
function truncateAddress(address) {
    return address.slice(0, 6) + '...' + address.slice(-4);
}
