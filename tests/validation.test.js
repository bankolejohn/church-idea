const { sanitize, validateId, validateMember, validateBranch, validatePastor, isValidEmail, isValidPhone } = require('../lib/validation');

describe('sanitize', () => {
    test('returns null for empty/null input', () => {
        expect(sanitize(null)).toBeNull();
        expect(sanitize(undefined)).toBeNull();
        expect(sanitize('')).toBeNull();
    });

    test('trims whitespace', () => {
        expect(sanitize('  hello  ')).toBe('hello');
    });

    test('strips HTML angle brackets', () => {
        expect(sanitize('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
    });

    test('preserves normal text', () => {
        expect(sanitize('John Smith')).toBe('John Smith');
    });

    test('truncates strings over 1000 chars', () => {
        const long = 'a'.repeat(2000);
        expect(sanitize(long).length).toBe(1000);
    });

    test('returns null for non-string types', () => {
        expect(sanitize(123)).toBeNull();
        expect(sanitize({})).toBeNull();
    });
});

describe('validateId', () => {
    test('returns parsed integer for valid IDs', () => {
        expect(validateId('1')).toBe(1);
        expect(validateId('123')).toBe(123);
        expect(validateId(456)).toBe(456);
    });

    test('returns null for invalid IDs', () => {
        expect(validateId('abc')).toBeNull();
        expect(validateId('0')).toBeNull();
        expect(validateId('-1')).toBeNull();
        expect(validateId('')).toBeNull();
        expect(validateId(null)).toBeNull();
    });
});

describe('isValidEmail', () => {
    test('accepts valid emails', () => {
        expect(isValidEmail('test@example.com')).toBe(true);
        expect(isValidEmail('user.name@domain.co.uk')).toBe(true);
    });

    test('rejects invalid emails', () => {
        expect(isValidEmail('notanemail')).toBe(false);
        expect(isValidEmail('@domain.com')).toBe(false);
        expect(isValidEmail('user@')).toBe(false);
    });

    test('accepts empty (email is optional)', () => {
        expect(isValidEmail('')).toBe(true);
        expect(isValidEmail(null)).toBe(true);
        expect(isValidEmail(undefined)).toBe(true);
    });
});

describe('isValidPhone', () => {
    test('accepts valid phone numbers', () => {
        expect(isValidPhone('+234-803-123-4567')).toBe(true);
        expect(isValidPhone('+1 555 0123')).toBe(true);
        expect(isValidPhone('(020) 7946-0958')).toBe(true);
    });

    test('rejects invalid phone numbers', () => {
        expect(isValidPhone('abc123')).toBe(false);
        expect(isValidPhone('phone@number')).toBe(false);
    });

    test('accepts empty (phone is optional)', () => {
        expect(isValidPhone('')).toBe(true);
        expect(isValidPhone(null)).toBe(true);
    });
});

describe('validateMember', () => {
    test('returns empty array for valid member', () => {
        const errors = validateMember({
            name: 'Grace Okafor',
            email: 'grace@email.com',
            phone: '+234-803-123',
            branch_id: 1
        });
        expect(errors).toEqual([]);
    });

    test('requires name', () => {
        const errors = validateMember({ name: '' });
        expect(errors).toContain('Member name is required');
    });

    test('validates email format', () => {
        const errors = validateMember({ name: 'Test', email: 'invalid' });
        expect(errors).toContain('Invalid email format');
    });

    test('validates phone format', () => {
        const errors = validateMember({ name: 'Test', phone: 'abc@def' });
        expect(errors).toContain('Invalid phone number format');
    });

    test('rejects oversized name', () => {
        const errors = validateMember({ name: 'a'.repeat(256) });
        expect(errors.length).toBeGreaterThan(0);
    });
});

describe('validateBranch', () => {
    test('returns empty array for valid branch', () => {
        const errors = validateBranch({ name: 'Lagos Branch', address: '123 Street' });
        expect(errors).toEqual([]);
    });

    test('requires name', () => {
        const errors = validateBranch({ name: '' });
        expect(errors).toContain('Branch name is required');
    });
});

describe('validatePastor', () => {
    test('returns empty array for valid pastor', () => {
        const errors = validatePastor({
            username: 'pastor_john',
            password: 'Strong1pass',
            branch_id: 1
        });
        expect(errors).toEqual([]);
    });

    test('requires username', () => {
        const errors = validatePastor({ username: '', password: 'Strong1pass', branch_id: 1 });
        expect(errors).toContain('Username is required');
    });

    test('enforces password complexity', () => {
        const errors = validatePastor({ username: 'test', password: 'weak', branch_id: 1 });
        expect(errors.some(e => e.includes('8 characters'))).toBe(true);
    });

    test('requires uppercase, lowercase, and number', () => {
        const errors = validatePastor({ username: 'test', password: 'alllowercase1', branch_id: 1 });
        expect(errors.some(e => e.includes('uppercase'))).toBe(true);
    });

    test('rejects special characters in username', () => {
        const errors = validatePastor({ username: 'user<script>', password: 'Strong1pass', branch_id: 1 });
        expect(errors.some(e => e.includes('letters, numbers'))).toBe(true);
    });

    test('requires branch_id', () => {
        const errors = validatePastor({ username: 'test', password: 'Strong1pass' });
        expect(errors).toContain('Branch is required');
    });
});
