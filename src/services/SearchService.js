import axios from 'axios';
import logger from '../utils/logger.js';

class SearchService {
    constructor() {
        this.baseUrl = process.env.API_HUB_BASE_URL || 'https://world-api.viverse.com';
    }

    /**
     * Search for rooms/worlds in VIVERSE
     * @param {Object} params 
     * @param {string} params.q - Search keyword (2-50 chars)
     * @param {string} [params.sort] - most_viewed, most_liked, create_date, first_public_date
     * @param {string} [params.tag] - comma separated tags
     * @param {string} [params.device] - desktop, mobile, vr
     * @param {number} [params.limit] - default 20
     * @param {string} [params.cursor] - pagination cursor
     * @returns {Promise<Object>}
     */
    async searchRooms(params) {
        try {
            const endpoint = `${this.baseUrl}/api/hubs-cms/v2/rooms/search`;

            // Robust query handling: trim and fallback to "world" if empty/whitespace
            const rawQ = params.q || '';
            const trimmedQ = rawQ.trim();
            const finalQ = trimmedQ.length > 0 ? trimmedQ : 'world';

            const searchParams = { ...params, q: finalQ };
            logger.info(`Searching rooms with query: "${searchParams.q}" at ${endpoint}`);

            const response = await axios.post(endpoint, searchParams, {
                headers: {
                    'Content-Type': 'application/json'
                    // Add Authorization header here if needed in the future
                }
            });

            const resultsCount = response.data?.results?.length || 0;
            logger.info(`Search API returned ${resultsCount} results.`);

            return response.data;
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            logger.error(`Searchrooms API Error: ${errorMsg}`);
            throw new Error(`Search failed: ${errorMsg}`);
        }
    }
}

export default new SearchService();
