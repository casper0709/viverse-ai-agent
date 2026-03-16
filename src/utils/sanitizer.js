/**
 * Sanitization utility to mask sensitive user credentials in dialogue and logs.
 */
const sanitizer = {
    /**
     * Replaces occurrences of email and password with [MASKED].
     * @param {string} text The text to sanitize
     * @param {Object} credentials The credentials object { email, password }
     * @returns {string} The sanitized text
     */
    sanitize: (text, credentials) => {
        if (!text || !credentials) return text;
        
        let sanitized = text;
        
        if (credentials.email) {
            // Escape any special regex characters in the email
            const escapedEmail = credentials.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const emailRegex = new RegExp(escapedEmail, 'gi');
            sanitized = sanitized.replace(emailRegex, '[MASKED]');
        }
        
        if (credentials.password) {
            // Escape any special regex characters in the password
            const escapedPassword = credentials.password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const passwordRegex = new RegExp(escapedPassword, 'gi');
            sanitized = sanitized.replace(passwordRegex, '[MASKED]');
        }

        // Generic pattern for potential lingering "Password: XXX" or "-p XXX" in tech speak
        // We only do this if it looks like a clear credential format to avoid over-masking
        sanitized = sanitized.replace(/(password[:\s]+)([^\s,]{3,})/gi, '$1[MASKED]');
        
        return sanitized;
    }
};

export default sanitizer;
