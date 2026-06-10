/**
 * Input validation and sanitization module.
 * Prevents XSS, injection, and malformed data from reaching the database or frontend.
 */

const MAX_LENGTHS = {
    name: 255,
    username: 100,
    password: 128,
    address: 500,
    workplace: 255,
    occupation: 255,
    department: 255,
    phone: 50,
    email: 255,
    pastor_name: 255
};

/**
 * Sanitize a string by trimming and removing dangerous characters.
 * Strips HTML tags to prevent stored XSS.
 */
function sanitize(value) {
    if (!value || typeof value !== 'string') return null;
    return value
        .trim()
        .replace(/[<>]/g, '') // Strip angle brackets (prevents HTML injection)
        .substring(0, 1000);   // Hard limit to prevent oversized payloads
}

/**
 * Validate an ID parameter (must be a positive integer).
 * Returns the parsed integer or null if invalid.
 */
function validateId(value) {
    const id = parseInt(value, 10);
    if (isNaN(id) || id <= 0 || id > 2147483647) {
        return null;
    }
    return id;
}

/**
 * Validate email format (basic check).
 */
function isValidEmail(email) {
    if (!email) return true; // Email is optional
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email) && email.length <= MAX_LENGTHS.email;
}

/**
 * Validate phone format (basic check - allows digits, +, -, spaces, parens).
 */
function isValidPhone(phone) {
    if (!phone) return true; // Phone is optional
    const phoneRegex = /^[0-9+\-\s()]+$/;
    return phoneRegex.test(phone) && phone.length <= MAX_LENGTHS.phone;
}

/**
 * Validate member input data.
 * Returns array of error messages (empty = valid).
 */
function validateMember(body) {
    const errors = [];

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
        errors.push('Member name is required');
    } else if (body.name.length > MAX_LENGTHS.name) {
        errors.push(`Name must be less than ${MAX_LENGTHS.name} characters`);
    }

    if (body.address && body.address.length > MAX_LENGTHS.address) {
        errors.push(`Address must be less than ${MAX_LENGTHS.address} characters`);
    }

    if (body.workplace && body.workplace.length > MAX_LENGTHS.workplace) {
        errors.push(`Workplace must be less than ${MAX_LENGTHS.workplace} characters`);
    }

    if (body.occupation && body.occupation.length > MAX_LENGTHS.occupation) {
        errors.push(`Occupation must be less than ${MAX_LENGTHS.occupation} characters`);
    }

    if (body.department && body.department.length > MAX_LENGTHS.department) {
        errors.push(`Department must be less than ${MAX_LENGTHS.department} characters`);
    }

    if (body.email && !isValidEmail(body.email)) {
        errors.push('Invalid email format');
    }

    if (body.phone && !isValidPhone(body.phone)) {
        errors.push('Invalid phone number format');
    }

    if (body.join_date && isNaN(Date.parse(body.join_date))) {
        errors.push('Invalid join date format');
    }

    if (body.branch_id && !validateId(body.branch_id)) {
        errors.push('Invalid branch ID');
    }

    return errors;
}

/**
 * Validate branch input data.
 * Returns array of error messages (empty = valid).
 */
function validateBranch(body) {
    const errors = [];

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
        errors.push('Branch name is required');
    } else if (body.name.length > MAX_LENGTHS.name) {
        errors.push(`Branch name must be less than ${MAX_LENGTHS.name} characters`);
    }

    if (body.address && body.address.length > MAX_LENGTHS.address) {
        errors.push(`Address must be less than ${MAX_LENGTHS.address} characters`);
    }

    if (body.pastor_name && body.pastor_name.length > MAX_LENGTHS.pastor_name) {
        errors.push(`Pastor name must be less than ${MAX_LENGTHS.pastor_name} characters`);
    }

    return errors;
}

/**
 * Validate pastor account creation input.
 * Returns array of error messages (empty = valid).
 */
function validatePastor(body) {
    const errors = [];

    if (!body.username || typeof body.username !== 'string' || body.username.trim().length === 0) {
        errors.push('Username is required');
    } else if (body.username.length > MAX_LENGTHS.username) {
        errors.push(`Username must be less than ${MAX_LENGTHS.username} characters`);
    } else if (!/^[a-zA-Z0-9_.-]+$/.test(body.username)) {
        errors.push('Username can only contain letters, numbers, underscores, dots, and hyphens');
    }

    if (!body.password || typeof body.password !== 'string') {
        errors.push('Password is required');
    } else if (body.password.length < 8) {
        errors.push('Password must be at least 8 characters');
    } else if (body.password.length > MAX_LENGTHS.password) {
        errors.push(`Password must be less than ${MAX_LENGTHS.password} characters`);
    } else if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(body.password)) {
        errors.push('Password must contain at least one uppercase letter, one lowercase letter, and one number');
    }

    if (!body.branch_id) {
        errors.push('Branch is required');
    } else if (!validateId(body.branch_id)) {
        errors.push('Invalid branch ID');
    }

    return errors;
}

module.exports = {
    sanitize,
    validateId,
    validateMember,
    validateBranch,
    validatePastor,
    isValidEmail,
    isValidPhone,
    MAX_LENGTHS
};
