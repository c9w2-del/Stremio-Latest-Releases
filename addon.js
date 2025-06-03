const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// Addon configuration
const manifest = {
    id: 'com.lateststreaming.addon',
    version: '1.0.0',
    name: 'Latest Streaming Releases',
    description: 'Discover the latest TV series and movies released on streaming platforms in USA, UK, Canada, New Zealand and Australia',
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

// API configuration with better error handling
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// Startup validation
console.log('🚀 Starting Stremio addon...');
console.log('📊 Environment check:');
console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`   PORT: ${process.env.PORT || 3000}`);
console.log(`   TMDB_API_KEY: ${TMDB_API_KEY ? '✅ Set (' + TMDB_API_KEY.substring(0, 8) + '...)' : '❌ Missing'}`);
console.log(`   OMDB_API_KEY: ${OMDB_API_KEY ? '✅ Set (' + OMDB_API_KEY.substring(0, 8) + '...)' : '⚠️  Missing'}`);

// Validate required API keys
if (!TMDB_API_KEY) {
    console.error('❌ CRITICAL ERROR: TMDB_API_KEY environment variable is required!');
    console.error('💡 Please set your TMDB API key in Render environment variables.');
    console.error('🔗 Get API key at: https://www.themoviedb.org/settings/api');
    process.exit(1);
}

// Test TMDB API key on startup
async function validateTMDBKey() {
    try {
        console.log('🔍 Testing TMDB API key...');
        const response = await axios.get(`${TMDB_BASE_URL}/configuration`, {
            params: { api_key: TMDB_API_KEY },
            timeout: 10000
        });
        console.log('✅ TMDB API key is valid');
        return true;
    } catch (error) {
        console.error('❌ TMDB API key validation failed:', error.response?.data?.status_message || error.message);
        return false;
    }
}

// Test OMDb API key if provided
async function validateOMDBKey() {
    if (!OMDB_API_KEY) {
        console.log('⚠️  OMDb API key not provided - IMDB ratings will be disabled');
        return false;
    }
    
    try {
        console.log('🔍 Testing OMDb API key...');
        const response = await axios.get(`http://www.omdbapi.com/?i=tt0111161&apikey=${OMDB_API_KEY}`, {
            timeout: 10000
        });
        if (response.data.Error) {
            console.error('❌ OMDb API key validation failed:', response.data.Error);
            return false;
        }
        console.log('✅ OMDb API key is valid');
        return true;
    } catch (error) {
        console.error('❌ OMDb API key validation failed:', error.message);
        return false;
    }
}

// Target regions for content
const TARGET_REGIONS = ['US', 'GB', 'CA', 'NZ', 'AU'];

// Rate limiting helper
const rateLimiter = {
    tmdbLastRequest: 0,
    tmdbMinInterval: 300, // Slightly more conservative: 3.3 requests per second
    
    async waitForTmdb() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.tmdbLastRequest;
        if (timeSinceLastRequest < this.tmdbMinInterval) {
            await new Promise(resolve => setTimeout(resolve, this.tmdbMinInterval - timeSinceLastRequest));
        }
        this.tmdbLastRequest = Date.now();
    }
};

// Helper function to get IMDB rating from OMDb API
async function getImdbRating(imdbId) {
    if (!OMDB_API_KEY || !imdbId) return null;
    
    try {
        const response = await axios.get(`http://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`, {
            timeout: 5000
        });
        
        if (response.data.Error) {
            return null;
        }
        
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
        
        console.log(`📡 Fetching ${type} data from TMDB (page ${page}, genre: ${genre || 'all'})`);
        
        let url;
        const currentDate = new Date();
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(currentDate.getMonth() - 3);
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
            region: TARGET_REGIONS[0],
            with_original_language: 'en',
            'vote_count.gte': 10 // Ensure quality content
        };

        // Set date filter based on content type
        if (type === 'movie') {
            params['primary_release_date.gte'] = dateString;
        } else {
            params['first_air_date.gte'] = dateString;
        }

        if (genre) {
            const genreMap = {
                'Action': 28,
                'Comedy': 35,
                'Drama': 18,
                'Horror': 27,
                'Romance': 10749,
                'Thriller': 53,
                'Sci-Fi': 878
            };
            if (genreMap[genre]) {
                params.with_genres = genreMap[genre];
            }
        }

        const response = await axios.get(url, { 
            params,
            timeout: 15000
        });
        
        console.log(`✅ Successfully fetched ${response.data.results?.length || 0} items from TMDB`);
        return response.data.results || [];
    } catch (error) {
        console.error('❌ Error fetching content from TMDB:', error.response?.data || error.message);
        return [];
    }
}

// Helper function to get streaming availability
async function getStreamingInfo(tmdbId, type) {
    try {
        await rateLimiter.waitForTmdb();
        
        const endpoint = type === 'movie' ? 'movie' : 'tv';
        const response = await axios.get(`${TMDB_BASE_URL}/${endpoint}/${tmdbId}/watch/providers`, {
            params: { api_key: TMDB_API_KEY },
            timeout: 10000
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
    const maxItems = Math.min(tmdbData.length, 15); // Reduced to prevent timeouts

    console.log(`🔄 Converting ${maxItems} items to Stremio format`);

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
                timeout: 10000
            });

            const details = detailsResponse.data;
            const imdbId = details.external_ids?.imdb_id;

            // Get streaming info with timeout
            let streamingInfo = [];
            try {
                const streamingPromise = getStreamingInfo(item.id, type);
                const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 5000));
                streamingInfo = await Promise.race([streamingPromise, timeoutPromise]);
            } catch (error) {
                console.error(`Error getting streaming info for ${item.id}:`, error.message);
            }

            // Get IMDB rating with timeout
            let imdbRating = null;
            if (imdbId && OMDB_API_KEY) {
                try {
                    const ratingPromise = getImdbRating(imdbId);
                    const ratingTimeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 3000));
                    imdbRating = await Promise.race([ratingPromise, ratingTimeoutPromise]);
                } catch (error) {
                    console.error(`Error getting IMDB rating for ${imdbId}:`, error.message);
                }
            }

            // Build description
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

            if (type === 'series') {
                stremioItem.imdb_id = imdbId;
            }

            items.push(stremioItem);
            
            if ((i + 1) % 5 === 0) {
                console.log(`✅ Processed ${i + 1}/${maxItems} items`);
            }
            
        } catch (error) {
            console.error(`❌ Error processing item ${item.id}:`, error.message);
        }
    }

    console.log(`🎉 Successfully converted ${items.length} items to Stremio format`);
    return items;
}

// Helper function to map genre IDs to names
function getGenreName(genreId) {
    const genreMap = {
        28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
        80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
        14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
        9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
        10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
    };
    return genreMap[genreId] || null;
}

// Catalog handler with comprehensive error handling
builder.defineCatalogHandler(({ type, id, extra }) => {
    return new Promise(async (resolve, reject) => {
        const startTime = Date.now();
        
        // Set overall timeout
        const timeout = setTimeout(() => {
            console.error(`⏰ Request timeout for ${type} catalog`);
            resolve({ metas: [] }); // Return empty instead of rejecting
        }, 30000);

        try {
            const page = extra.skip ? Math.floor(extra.skip / 20) + 1 : 1;
            const genre = extra.genre || null;

            console.log(`📋 Handling ${type} catalog request (page ${page}, genre: ${genre || 'all'})`);

            const tmdbData = await fetchLatestContent(type, page, genre);
            
            if (tmdbData.length === 0) {
                console.log(`📭 No content found for ${type} catalog`);
                clearTimeout(timeout);
                resolve({ metas: [] });
                return;
            }

            const stremioItems = await convertToStremioFormat(tmdbData, type);
            
            const duration = Date.now() - startTime;
            console.log(`🎯 Catalog request completed in ${duration}ms, returning ${stremioItems.length} items`);

            clearTimeout(timeout);
            resolve({ metas: stremioItems });
            
        } catch (error) {
            clearTimeout(timeout);
            console.error(`❌ Critical error in catalog handler:`, error.message);
            console.error(`Stack trace:`, error.stack);
            
            // Return empty results instead of failing
            resolve({ metas: [] });
        }
    });
});

// Export the addon interface
const addonInterface = builder.getInterface();

// Server setup using serveHTTP from stremio-addon-sdk
if (require.main === module) {
    const PORT = process.env.PORT || 3000;

    // Validate API keys before starting server
    (async () => {
        console.log('🔍 Validating API keys...');
        
        const tmdbValid = await validateTMDBKey();
        if (!tmdbValid) {
            console.error('❌ Cannot start server without valid TMDB API key');
            process.exit(1);
        }
        
        await validateOMDBKey(); // OMDb is optional
        
        console.log('✅ API validation complete, starting server...');
        
        // Start the server using serveHTTP
        serveHTTP(addonInterface, {
            port: PORT,
            cache: false // Disable caching for development
        }).then(() => {
            console.log('\n🎉 =================================');
            console.log('🚀 Stremio addon server started!');
            console.log('🎉 =================================');
            console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🌐 Port: ${PORT}`);
            console.log(`🔗 External URL: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
            console.log(`📋 Manifest: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/manifest.json`);
            console.log(`❤️  Health: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/health`);
            console.log('🎉 =================================\n');
        }).catch(error => {
            console.error('💥 Failed to start server:', error);
            process.exit(1);
        });
        
    })().catch(error => {
        console.error('💥 Fatal startup error:', error);
        process.exit(1);
    });
}

// Export for external use
module.exports = addonInterface;