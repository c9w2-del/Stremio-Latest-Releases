const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');

// Addon configuration
const manifest = {
    id: 'com.lateststreaming.addon',
    version: '1.0.0',
    name: 'Latest Streaming Releases',
    description: 'Discover the latest TV series and movies released on streaming platforms',
    logo: 'https://via.placeholder.com/256x256/007acc/ffffff?text=LSR',
    background: 'https://via.placeholder.com/1920x1080/1a1a1a/ffffff?text=Latest+Streaming',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs: [
        {
            type: 'movie',
            id: 'latest-movies',
            name: 'Latest Movies',
            extra: [
                { name: 'skip', isRequired: false },
                { name: 'genre', isRequired: false, options: ['Action', 'Comedy', 'Drama', 'Horror', 'Romance', 'Thriller', 'Sci-Fi'] }
            ]
        },
        {
            type: 'series',
            id: 'latest-series',
            name: 'Latest TV Series',
            extra: [
                { name: 'skip', isRequired: false },
                { name: 'genre', isRequired: false, options: ['Action', 'Comedy', 'Drama', 'Horror', 'Romance', 'Thriller', 'Sci-Fi'] }
            ]
        }
    ]
};

const builder = new addonBuilder(manifest);

// API configuration - using environment variables for production
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'a19303475ba51d055949062229dc89a0';
const OMDB_API_KEY = process.env.OMDB_API_KEY || 'b879cac6';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// Validate API keys
if (!TMDB_API_KEY) {
    console.error('ERROR: TMDB_API_KEY environment variable is required');
    process.exit(1);
}

if (!OMDB_API_KEY) {
    console.warn('WARNING: OMDB_API_KEY not set - IMDB ratings will not be available');
}

// Target regions for content
const TARGET_REGIONS = ['US', 'GB', 'CA', 'NZ', 'AU'];

// Rate limiting helper
const rateLimiter = {
    tmdbLastRequest: 0,
    tmdbMinInterval: 250, // 4 requests per second for TMDB
    
    async waitForTmdb() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.tmdbLastRequest;
        if (timeSinceLastRequest < this.tmdbMinInterval) {
            await new Promise(resolve => setTimeout(resolve, this.tmdbMinInterval - timeSinceLastRequest));
        }
        this.tmdbLastRequest = Date.now();
    }
};

// Helper function to get IMDB rating from OMDb API (free)
async function getImdbRating(imdbId) {
    if (!OMDB_API_KEY || !imdbId) return null;
    
    try {
        const response = await axios.get(`http://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`, {
            timeout: 5000
        });
        return response.data.imdbRating !== 'N/A' ? response.data.imdbRating : null;
    } catch (error) {
        console.error('Error fetching IMDB rating:', error.message);
        return null;
    }
}

// Helper function to fetch latest content from TMDB
async function fetchLatestContent(type, page = 1, genre = null) {
    try {
        await rateLimiter.waitForTmdb();
        
        let url;
        const currentDate = new Date();
        const threeMonthsAgo = new Date(currentDate.setMonth(currentDate.getMonth() - 3));
        const dateString = threeMonthsAgo.toISOString().split('T')[0];

        if (type === 'movie') {
            url = `${TMDB_BASE_URL}/discover/movie`;
        } else {
            url = `${TMDB_BASE_URL}/discover/tv`;
        }

        const params = {
            api_key: TMDB_API_KEY,
            sort_by: type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc',
            page: page,
            region: TARGET_REGIONS[0], // Primary region
            with_original_language: 'en'
        };

        // Set date filter based on content type
        if (type === 'movie') {
            params['primary_release_date.gte'] = dateString;
        } else {
            params['first_air_date.gte'] = dateString;
        }

        if (genre) {
            // Map genre names to TMDB genre IDs
            const genreMap = {
                'Action': 28,
                'Comedy': 35,
                'Drama': 18,
                'Horror': 27,
                'Romance': 10749,
                'Thriller': 53,
                'Sci-Fi': 878
            };
            params.with_genres = genreMap[genre];
        }

        const response = await axios.get(url, { 
            params,
            timeout: 10000
        });
        
        return response.data.results || [];
    } catch (error) {
        console.error('Error fetching content from TMDB:', error.message);
        return [];
    }
}

// Helper function to get streaming availability
async function getStreamingInfo(tmdbId, type) {
    try {
        await rateLimiter.waitForTmdb();
        
        const endpoint = type === 'movie' ? 'movie' : 'tv';
        const response = await axios.get(`${TMDB_BASE_URL}/${endpoint}/${tmdbId}/watch/providers`, {
            params: {
                api_key: TMDB_API_KEY
            },
            timeout: 8000
        });

        const providers = response.data.results;
        const availableRegions = [];

        TARGET_REGIONS.forEach(region => {
            if (providers[region] && providers[region].flatrate) {
                availableRegions.push({
                    region: region,
                    providers: providers[region].flatrate.map(p => p.provider_name)
                });
            }
        });

        return availableRegions;
    } catch (error) {
        console.error('Error fetching streaming info:', error.message);
        return [];
    }
}

// Convert TMDB data to Stremio format
async function convertToStremioFormat(tmdbData, type) {
    const items = [];
    const maxItems = Math.min(tmdbData.length, 20); // Limit to prevent timeout

    for (let i = 0; i < maxItems; i++) {
        const item = tmdbData[i];
        try {
            await rateLimiter.waitForTmdb();
            
            // Get additional details including IMDB ID
            const endpoint = type === 'movie' ? 'movie' : 'tv';
            const detailsResponse = await axios.get(`${TMDB_BASE_URL}/${endpoint}/${item.id}`, {
                params: {
                    api_key: TMDB_API_KEY,
                    append_to_response: 'external_ids'
                },
                timeout: 8000
            });

            const details = detailsResponse.data;
            const imdbId = details.external_ids?.imdb_id;

            // Get streaming info (with timeout protection)
            const streamingInfoPromise = getStreamingInfo(item.id, type);
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 3000));
            const streamingInfo = await Promise.race([streamingInfoPromise, timeoutPromise]);

            // Get IMDB rating (with timeout protection)
            let imdbRating = null;
            if (imdbId && OMDB_API_KEY) {
                const ratingPromise = getImdbRating(imdbId);
                const ratingTimeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 2000));
                imdbRating = await Promise.race([ratingPromise, ratingTimeoutPromise]);
            }

            // Build description with streaming info
            let description = item.overview || 'No description available.';
            if (streamingInfo.length > 0) {
                description += '\n\n🎬 Available on:\n';
                streamingInfo.forEach(region => {
                    const regionNames = {
                        'US': 'United States',
                        'GB': 'United Kingdom', 
                        'CA': 'Canada',
                        'NZ': 'New Zealand',
                        'AU': 'Australia'
                    };
                    description += `${regionNames[region.region]}: ${region.providers.join(', ')}\n`;
                });
            }

            if (imdbRating) {
                description += `\n⭐ IMDB Rating: ${imdbRating}/10`;
            }

            const stremioItem = {
                id: `tmdb:${item.id}`,
                type: type,
                name: type === 'movie' ? item.title : item.name,
                poster: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : null,
                background: item.backdrop_path ? `${TMDB_IMAGE_BASE}${item.backdrop_path}` : null,
                description: description,
                releaseInfo: type === 'movie' ? item.release_date : item.first_air_date,
                imdbRating: imdbRating ? parseFloat(imdbRating) : undefined,
                genres: item.genre_ids ? item.genre_ids.map(id => getGenreName(id)).filter(Boolean) : []
            };

            // Add series-specific fields
            if (type === 'series') {
                stremioItem.imdb_id = imdbId;
            }

            items.push(stremioItem);
        } catch (error) {
            console.error(`Error processing item ${item.id}:`, error.message);
            // Continue with next item instead of failing completely
        }
    }

    return items;
}

// Helper function to map genre IDs to names
function getGenreName(genreId) {
    const genreMap = {
        28: 'Action',
        12: 'Adventure',
        16: 'Animation',
        35: 'Comedy',
        80: 'Crime',
        99: 'Documentary',
        18: 'Drama',
        10751: 'Family',
        14: 'Fantasy',
        36: 'History',
        27: 'Horror',
        10402: 'Music',
        9648: 'Mystery',
        10749: 'Romance',
        878: 'Science Fiction',
        10770: 'TV Movie',
        53: 'Thriller',
        10752: 'War',
        37: 'Western'
    };
    return genreMap[genreId] || null;
}

// Catalog handler with timeout protection
builder.defineCatalogHandler(({ type, id, extra }) => {
    return new Promise(async (resolve, reject) => {
        // Set overall timeout for the request
        const timeout = setTimeout(() => {
            reject(new Error('Request timeout'));
        }, 25000); // 25 second timeout

        try {
            const page = extra.skip ? Math.floor(extra.skip / 20) + 1 : 1;
            const genre = extra.genre || null;

            console.log(`Fetching ${type} catalog, page ${page}, genre: ${genre}`);

            const tmdbData = await fetchLatestContent(type, page, genre);
            
            if (tmdbData.length === 0) {
                clearTimeout(timeout);
                resolve({ metas: [] });
                return;
            }

            const stremioItems = await convertToStremioFormat(tmdbData, type);

            clearTimeout(timeout);
            resolve({
                metas: stremioItems
            });
        } catch (error) {
            clearTimeout(timeout);
            console.error('Error in catalog handler:', error);
            // Return empty results instead of failing completely
            resolve({ metas: [] });
        }
    });
});

// Export the addon
module.exports = builder.getInterface();

// Server setup for Render
if (require.main === module) {
    const express = require('express');
    const app = express();
    const PORT = process.env.PORT || 3000;

    // Enable CORS
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        next();
    });

    // Health check endpoint for Render
    app.get('/health', (req, res) => {
        res.status(200).json({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            version: manifest.version,
            environment: process.env.NODE_ENV || 'development'
        });
    });

    // Basic info endpoint
    app.get('/', (req, res) => {
        res.json({
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            manifest: `${req.protocol}://${req.get('host')}/manifest.json`,
            health: `${req.protocol}://${req.get('host')}/health`
        });
    });

    // Serve the addon
    app.use('/', builder.getRouter());

    // Error handling
    app.use((err, req, res, next) => {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Stremio addon running on port ${PORT}`);
        console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`🌐 External URL: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
        console.log(`📋 Manifest: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/manifest.json`);
        console.log(`❤️  Health check: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/health`);
        
        // Log API key status
        console.log(`🔑 TMDB API Key: ${TMDB_API_KEY ? '✅ Set' : '❌ Missing'}`);
        console.log(`🔑 OMDb API Key: ${OMDB_API_KEY ? '✅ Set' : '⚠️  Missing (IMDB ratings disabled)'}`);
    });
}