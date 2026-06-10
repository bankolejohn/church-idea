/**
 * Church Management System - Frontend Application
 * 
 * Security notes:
 * - All user-generated content is escaped via textContent (never innerHTML with raw data)
 * - Token stored in memory during session, localStorage for persistence
 * - All API calls include Authorization header
 */

class ChurchManagementApp {
    constructor() {
        this.token = localStorage.getItem('token');
        this.user = null;
        this.branches = [];
        this.members = [];
        this.stats = null;
        this.currentEditingMember = null;
        this.currentEditingBranch = null;

        this.init();
    }

    async init() {
        if (this.token) {
            try {
                await this.getCurrentUser();
                this.showMainApp();
                await this.loadData();
            } catch (error) {
                this.showLogin();
            }
        } else {
            this.showLogin();
        }

        this.setupEventListeners();
    }

    // ──────────────────────────────────────────
    // Utility: Safe text escaping
    // ──────────────────────────────────────────

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    createEl(tag, attrs = {}, children = []) {
        const el = document.createElement(tag);
        Object.entries(attrs).forEach(([key, value]) => {
            if (key === 'className') el.className = value;
            else if (key === 'textContent') el.textContent = value;
            else if (key === 'onclick') el.addEventListener('click', value);
            else if (key === 'style') Object.assign(el.style, value);
            else el.setAttribute(key, value);
        });
        children.forEach(child => {
            if (typeof child === 'string') {
                el.appendChild(document.createTextNode(child));
            } else if (child) {
                el.appendChild(child);
            }
        });
        return el;
    }

    // ──────────────────────────────────────────
    // Event Listeners
    // ──────────────────────────────────────────

    setupEventListeners() {
        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.login();
        });

        document.getElementById('logout-btn').addEventListener('click', () => this.logout());

        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchPage(e.target.dataset.page));
        });

        document.getElementById('add-member-btn').addEventListener('click', () => this.openMemberModal());
        document.getElementById('close-member-modal').addEventListener('click', () => this.closeMemberModal());
        document.getElementById('cancel-member').addEventListener('click', () => this.closeMemberModal());

        document.getElementById('add-branch-btn').addEventListener('click', () => this.openBranchModal());
        document.getElementById('close-branch-modal').addEventListener('click', () => this.closeBranchModal());
        document.getElementById('cancel-branch').addEventListener('click', () => this.closeBranchModal());

        document.getElementById('member-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveMember();
        });

        document.getElementById('branch-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveBranch();
        });

        document.getElementById('create-pastor-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.createPastorAccount();
        });

        document.getElementById('pastor-branch').addEventListener('change', (e) => {
            this.handleBranchSelection(e.target.value);
        });

        document.getElementById('cancel-new-branch').addEventListener('click', () => this.cancelNewBranch());

        document.getElementById('pastor-password').addEventListener('input', () => this.validatePasswords());
        document.getElementById('pastor-confirm-password').addEventListener('input', () => this.validatePasswords());

        document.getElementById('member-is-worker').addEventListener('change', (e) => {
            document.getElementById('worker-department-group').style.display = e.target.checked ? 'block' : 'none';
        });

        document.getElementById('member-search').addEventListener('input', () => this.renderMembers());
        document.getElementById('branch-filter').addEventListener('change', () => this.renderMembers());

        document.getElementById('member-modal').addEventListener('click', (e) => {
            if (e.target.id === 'member-modal') this.closeMemberModal();
        });

        document.getElementById('branch-modal').addEventListener('click', (e) => {
            if (e.target.id === 'branch-modal') this.closeBranchModal();
        });
    }

    // ──────────────────────────────────────────
    // Authentication
    // ──────────────────────────────────────────

    async login() {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('login-error');

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (response.ok) {
                this.token = data.token;
                this.user = data.user;
                localStorage.setItem('token', this.token);
                this.showMainApp();
                await this.loadData();
            } else {
                errorDiv.textContent = data.error;
                errorDiv.classList.add('show');
            }
        } catch (error) {
            errorDiv.textContent = 'Connection error. Please try again.';
            errorDiv.classList.add('show');
        }
    }

    logout() {
        this.token = null;
        this.user = null;
        localStorage.removeItem('token');
        this.showLogin();
    }

    async getCurrentUser() {
        const response = await fetch('/api/me', {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        if (!response.ok) throw new Error('Invalid token');
        const data = await response.json();
        this.user = data.user;
    }

    showLogin() {
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('main-app').style.display = 'none';
        document.getElementById('login-error').classList.remove('show');
    }

    showMainApp() {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-app').style.display = 'block';
        this.updateUIForRole();
    }

    updateUIForRole() {
        const userRoleSpan = document.getElementById('user-role');
        const userBranchSpan = document.getElementById('user-branch');
        const addMemberBtn = document.getElementById('add-member-btn');
        const addBranchBtn = document.getElementById('add-branch-btn');
        const adminNav = document.getElementById('admin-nav');

        if (this.user.role === 'main_leader') {
            userRoleSpan.textContent = 'Main Leader';
            userBranchSpan.classList.remove('show');
            addBranchBtn.style.display = 'block';
            adminNav.style.display = 'block';
            addMemberBtn.style.display = 'none';
            document.title = 'Church Management System - Main Leader';
        } else if (this.user.role === 'branch_pastor') {
            userRoleSpan.textContent = 'Branch Pastor';

            if (this.user.branch_name) {
                userBranchSpan.textContent = this.user.branch_name;
                userBranchSpan.classList.add('show');
                document.title = `Church Management - ${this.user.branch_name}`;
            }

            addMemberBtn.style.display = 'block';
            addBranchBtn.style.display = 'none';
            adminNav.style.display = 'none';
        }
    }

    // ──────────────────────────────────────────
    // Data Loading
    // ──────────────────────────────────────────

    async loadData() {
        await Promise.all([
            this.loadBranches(),
            this.loadMembers(),
            this.loadStats()
        ]);

        this.renderDashboard();
        this.renderMembers();
        this.renderBranches();
        this.updateBranchSelects();
    }

    async loadBranches() {
        const response = await fetch('/api/branches', {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (response.ok) this.branches = await response.json();
    }

    async loadMembers() {
        const response = await fetch('/api/members', {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (response.ok) this.members = await response.json();
    }

    async loadStats() {
        try {
            const response = await fetch('/api/stats', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (response.ok) this.stats = await response.json();
        } catch (error) {
            // Stats loading failure is non-critical
        }
    }

    async apiCall(url, method = 'GET', data = null) {
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            }
        };

        if (data) options.body = JSON.stringify(data);

        const response = await fetch(url, options);

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Request failed');
        }

        return response.json();
    }

    switchPage(page) {
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelector(`[data-page="${page}"]`).classList.add('active');
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(page).classList.add('active');
    }

    // ──────────────────────────────────────────
    // Branch Management
    // ──────────────────────────────────────────

    openBranchModal(branch = null) {
        this.currentEditingBranch = branch;
        const title = document.getElementById('branch-modal-title');
        const form = document.getElementById('branch-form');

        if (branch) {
            title.textContent = 'Edit Branch';
            document.getElementById('branch-name').value = branch.name || '';
            document.getElementById('branch-address').value = branch.address || '';
            document.getElementById('branch-pastor').value = branch.pastor_name || '';
        } else {
            title.textContent = 'Add Branch';
            form.reset();
        }

        document.getElementById('branch-modal').classList.add('active');
    }

    closeBranchModal() {
        document.getElementById('branch-modal').classList.remove('active');
        this.currentEditingBranch = null;
    }

    async saveBranch() {
        const name = document.getElementById('branch-name').value.trim();
        const address = document.getElementById('branch-address').value.trim();
        const pastor_name = document.getElementById('branch-pastor').value.trim();

        if (!name) {
            alert('Branch name is required');
            return;
        }

        try {
            if (this.currentEditingBranch) {
                await this.apiCall(`/api/branches/${this.currentEditingBranch.id}`, 'PUT', { name, address, pastor_name });
            } else {
                await this.apiCall('/api/branches', 'POST', { name, address, pastor_name });
            }

            await this.loadData();
            this.closeBranchModal();
            this.showSuccessMessage('Branch saved successfully');
        } catch (error) {
            alert('Error saving branch: ' + error.message);
        }
    }

    // ──────────────────────────────────────────
    // Member Management
    // ──────────────────────────────────────────

    openMemberModal(member = null) {
        this.currentEditingMember = member;
        const title = document.getElementById('member-modal-title');
        const form = document.getElementById('member-form');
        const departmentGroup = document.getElementById('worker-department-group');

        if (member) {
            title.textContent = 'Edit Member';
            document.getElementById('member-name').value = member.name || '';
            document.getElementById('member-address').value = member.address || '';
            document.getElementById('member-workplace').value = member.workplace || '';
            document.getElementById('member-occupation').value = member.occupation || '';
            document.getElementById('member-join-date').value = member.join_date ? member.join_date.substring(0, 10) : '';
            document.getElementById('member-is-worker').checked = member.is_worker || false;
            document.getElementById('member-department').value = member.department || '';
            document.getElementById('member-phone').value = member.phone || '';
            document.getElementById('member-email').value = member.email || '';
            departmentGroup.style.display = member.is_worker ? 'block' : 'none';
        } else {
            title.textContent = 'Add Member';
            form.reset();
            departmentGroup.style.display = 'none';
        }

        document.getElementById('member-modal').classList.add('active');
    }

    closeMemberModal() {
        document.getElementById('member-modal').classList.remove('active');
        this.currentEditingMember = null;
    }

    async saveMember() {
        const name = document.getElementById('member-name').value.trim();
        if (!name) {
            alert('Name is required');
            return;
        }

        const memberData = {
            name,
            address: document.getElementById('member-address').value.trim(),
            workplace: document.getElementById('member-workplace').value.trim(),
            occupation: document.getElementById('member-occupation').value.trim(),
            join_date: document.getElementById('member-join-date').value,
            branch_id: this.user.branch_id,
            is_worker: document.getElementById('member-is-worker').checked,
            department: document.getElementById('member-department').value.trim(),
            phone: document.getElementById('member-phone').value.trim(),
            email: document.getElementById('member-email').value.trim()
        };

        try {
            if (this.currentEditingMember) {
                await this.apiCall(`/api/members/${this.currentEditingMember.id}`, 'PUT', memberData);
            } else {
                await this.apiCall('/api/members', 'POST', memberData);
            }

            await this.loadData();
            this.closeMemberModal();
            this.showSuccessMessage('Member saved successfully');
        } catch (error) {
            alert('Error saving member: ' + error.message);
        }
    }

    async deleteMember(memberId) {
        if (confirm('Are you sure you want to delete this member?')) {
            try {
                await this.apiCall(`/api/members/${memberId}`, 'DELETE');
                await this.loadData();
                this.showSuccessMessage('Member deleted successfully');
            } catch (error) {
                alert('Error deleting member: ' + error.message);
            }
        }
    }

    // ──────────────────────────────────────────
    // Admin Functions
    // ──────────────────────────────────────────

    handleBranchSelection(value) {
        const newBranchSection = document.getElementById('new-branch-section');
        const newBranchName = document.getElementById('new-branch-name');

        if (value === 'create-new') {
            newBranchSection.style.display = 'block';
            newBranchName.required = true;
            const username = document.getElementById('pastor-username').value.trim();
            if (username) {
                document.getElementById('new-branch-pastor-name').value = username;
            }
        } else {
            newBranchSection.style.display = 'none';
            newBranchName.required = false;
            this.clearNewBranchForm();
        }
    }

    cancelNewBranch() {
        document.getElementById('pastor-branch').value = '';
        document.getElementById('new-branch-section').style.display = 'none';
        document.getElementById('new-branch-name').required = false;
        this.clearNewBranchForm();
    }

    clearNewBranchForm() {
        document.getElementById('new-branch-name').value = '';
        document.getElementById('new-branch-address').value = '';
        document.getElementById('new-branch-pastor-name').value = '';
    }

    validatePasswords() {
        const password = document.getElementById('pastor-password').value;
        const confirmPassword = document.getElementById('pastor-confirm-password').value;
        const confirmField = document.getElementById('pastor-confirm-password');

        const existingFeedback = confirmField.parentNode.querySelector('.password-feedback');
        if (existingFeedback) existingFeedback.remove();
        confirmField.classList.remove('password-match', 'password-mismatch');

        if (confirmPassword.length === 0) return;

        const feedback = document.createElement('div');
        feedback.className = 'password-feedback';

        if (password === confirmPassword) {
            if (password.length >= 8 && /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
                confirmField.classList.add('password-match');
                feedback.classList.add('match');
                feedback.textContent = '✓ Passwords match';
            } else {
                feedback.classList.add('weak');
                feedback.textContent = '⚠ Must be 8+ characters with uppercase, lowercase, and number';
            }
        } else {
            confirmField.classList.add('password-mismatch');
            feedback.classList.add('mismatch');
            feedback.textContent = '✗ Passwords do not match';
        }

        confirmField.parentNode.appendChild(feedback);
    }

    clearPasswordValidation() {
        const confirmField = document.getElementById('pastor-confirm-password');
        const existingFeedback = confirmField.parentNode.querySelector('.password-feedback');
        if (existingFeedback) existingFeedback.remove();
        confirmField.classList.remove('password-match', 'password-mismatch');
    }

    async createPastorAccount() {
        const username = document.getElementById('pastor-username').value.trim();
        const password = document.getElementById('pastor-password').value;
        const confirmPassword = document.getElementById('pastor-confirm-password').value;
        const branchSelection = document.getElementById('pastor-branch').value;

        if (!username || !password || !confirmPassword || !branchSelection) {
            alert('All fields are required');
            return;
        }

        if (password !== confirmPassword) {
            alert('Passwords do not match.');
            return;
        }

        if (password.length < 8 || !/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
            alert('Password must be at least 8 characters with uppercase, lowercase, and a number.');
            return;
        }

        try {
            let branch_id;

            if (branchSelection === 'create-new') {
                const branchName = document.getElementById('new-branch-name').value.trim();
                const branchAddress = document.getElementById('new-branch-address').value.trim();
                const pastorName = document.getElementById('new-branch-pastor-name').value.trim() || username;

                if (!branchName) {
                    alert('Branch name is required when creating a new branch');
                    return;
                }

                const newBranch = await this.apiCall('/api/branches', 'POST', {
                    name: branchName, address: branchAddress, pastor_name: pastorName
                });
                branch_id = newBranch.id;
            } else {
                branch_id = parseInt(branchSelection);
            }

            await this.apiCall('/api/create-pastor', 'POST', { username, password, branch_id });

            await this.loadData();
            document.getElementById('create-pastor-form').reset();
            this.cancelNewBranch();
            this.clearPasswordValidation();

            this.showSuccessMessage('Pastor account created successfully' +
                (branchSelection === 'create-new' ? ' (new branch created)' : ''));
        } catch (error) {
            alert('Error: ' + error.message);
        }
    }

    // ──────────────────────────────────────────
    // Rendering (XSS-safe)
    // ──────────────────────────────────────────

    renderDashboard() {
        if (!this.stats) return;

        document.getElementById('total-members').textContent = this.stats.total_members;
        document.getElementById('total-branches').textContent = this.stats.total_branches;

        const container = document.getElementById('branches-list');
        container.innerHTML = '';

        if (!this.stats.branches || this.stats.branches.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:2rem;color:#7f8c8d;">No branches found</div>';
            return;
        }

        this.stats.branches.forEach(branch => {
            const card = this.createEl('div', { className: 'branch-card' });

            const title = this.createEl('h4', { textContent: branch.name });
            const addr = this.createEl('div', { className: 'branch-info', textContent: `📍 ${branch.address || 'No address provided'}` });
            const pastor = this.createEl('div', { className: 'branch-info', textContent: `👨‍💼 Pastor: ${branch.pastor_name || 'Not assigned'}` });
            const count = this.createEl('span', { className: 'member-count', textContent: `${branch.member_count} members` });

            card.appendChild(title);
            card.appendChild(addr);
            card.appendChild(pastor);
            card.appendChild(count);

            if (this.user.role === 'main_leader') {
                card.style.cursor = 'pointer';
                card.addEventListener('click', () => {
                    this.switchPage('members');
                    document.getElementById('branch-filter').value = branch.id;
                    this.renderMembers();
                });
            }

            container.appendChild(card);
        });
    }

    renderMembers() {
        const searchTerm = document.getElementById('member-search').value.toLowerCase();
        const branchFilter = document.getElementById('branch-filter').value;

        let filtered = this.members;

        if (searchTerm) {
            filtered = filtered.filter(m =>
                m.name.toLowerCase().includes(searchTerm) ||
                (m.occupation && m.occupation.toLowerCase().includes(searchTerm)) ||
                (m.department && m.department.toLowerCase().includes(searchTerm)) ||
                (m.phone && m.phone.includes(searchTerm)) ||
                (m.email && m.email.toLowerCase().includes(searchTerm))
            );
        }

        if (branchFilter) {
            filtered = filtered.filter(m => m.branch_id === parseInt(branchFilter));
        }

        const container = document.getElementById('members-list');
        container.innerHTML = '';

        if (filtered.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:2rem;color:#7f8c8d;">No members found</div>';
            return;
        }

        filtered.forEach(member => {
            const card = this.createEl('div', { className: 'member-card' });

            // Header
            const header = this.createEl('div', { className: 'member-header' });
            header.appendChild(this.createEl('div', { className: 'member-name', textContent: member.name }));
            header.appendChild(this.createEl('div', { className: 'member-branch', textContent: member.branch_name }));
            card.appendChild(header);

            // Details
            const details = this.createEl('div', { className: 'member-details' });
            if (member.phone) details.appendChild(this.createEl('div', { className: 'member-detail', textContent: `📞 ${member.phone}` }));
            if (member.email) details.appendChild(this.createEl('div', { className: 'member-detail', textContent: `✉️ ${member.email}` }));
            if (member.occupation) details.appendChild(this.createEl('div', { className: 'member-detail', textContent: `💼 ${member.occupation}` }));
            if (member.workplace) details.appendChild(this.createEl('div', { className: 'member-detail', textContent: `🏢 ${member.workplace}` }));
            if (member.address) details.appendChild(this.createEl('div', { className: 'member-detail', textContent: `🏠 ${member.address}` }));
            if (member.join_date) details.appendChild(this.createEl('div', { className: 'member-detail', textContent: `📅 Joined: ${new Date(member.join_date).toLocaleDateString()}` }));
            card.appendChild(details);

            // Worker badge
            if (member.is_worker) {
                card.appendChild(this.createEl('div', { className: 'worker-badge', textContent: `⭐ ${member.department || 'Church Worker'}` }));
            }

            // Actions (branch pastor only)
            if (this.user.role === 'branch_pastor') {
                const actions = this.createEl('div', { className: 'member-actions' });

                const editBtn = this.createEl('button', { className: 'btn-secondary', textContent: 'Edit' });
                editBtn.addEventListener('click', () => this.openMemberModal(member));

                const deleteBtn = this.createEl('button', { className: 'btn-danger', textContent: 'Delete' });
                deleteBtn.addEventListener('click', () => this.deleteMember(member.id));

                actions.appendChild(editBtn);
                actions.appendChild(deleteBtn);
                card.appendChild(actions);
            }

            container.appendChild(card);
        });
    }

    renderBranches() {
        const container = document.getElementById('branches-grid');
        container.innerHTML = '';

        if (this.branches.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:2rem;color:#7f8c8d;">No branches added yet</div>';
            return;
        }

        this.branches.forEach(branch => {
            const memberCount = this.members.filter(m => m.branch_id === branch.id).length;
            const card = this.createEl('div', { className: 'branch-card' });

            card.appendChild(this.createEl('h4', { textContent: branch.name }));
            card.appendChild(this.createEl('div', { className: 'branch-info', textContent: `📍 ${branch.address || 'No address provided'}` }));
            card.appendChild(this.createEl('div', { className: 'branch-info', textContent: `👨‍💼 Pastor: ${branch.pastor_name || 'Not assigned'}` }));
            card.appendChild(this.createEl('span', { className: 'member-count', textContent: `${memberCount} members` }));

            if (this.user.role === 'main_leader') {
                const actions = this.createEl('div', { style: { marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } });

                const editBtn = this.createEl('button', { className: 'btn-secondary', textContent: 'Edit' });
                editBtn.addEventListener('click', () => this.openBranchModal(branch));

                const viewBtn = this.createEl('button', { className: 'btn-primary', textContent: 'View Members' });
                viewBtn.addEventListener('click', () => this.viewBranchMembers(branch.id));

                actions.appendChild(editBtn);
                actions.appendChild(viewBtn);
                card.appendChild(actions);
            }

            container.appendChild(card);
        });
    }

    viewBranchMembers(branchId) {
        this.switchPage('members');
        document.getElementById('branch-filter').value = branchId;
        this.renderMembers();
    }

    updateBranchSelects() {
        const selects = [
            document.getElementById('branch-filter'),
            document.getElementById('pastor-branch')
        ];

        selects.forEach(select => {
            const currentValue = select.value;
            const isFilter = select.id === 'branch-filter';
            const isPastorBranch = select.id === 'pastor-branch';

            select.innerHTML = isFilter
                ? '<option value="">All Branches</option>'
                : '<option value="">Select Branch</option>';

            this.branches.forEach(branch => {
                const option = document.createElement('option');
                option.value = branch.id;
                option.textContent = branch.name;
                select.appendChild(option);
            });

            if (isPastorBranch) {
                const createNewOption = document.createElement('option');
                createNewOption.value = 'create-new';
                createNewOption.textContent = '+ Create New Branch';
                select.appendChild(createNewOption);
            }

            select.value = currentValue;
        });
    }

    showSuccessMessage(message) {
        const successDiv = document.createElement('div');
        successDiv.className = 'success-message show';
        successDiv.textContent = message;

        const main = document.querySelector('.main');
        main.insertBefore(successDiv, main.firstChild);

        setTimeout(() => successDiv.remove(), 3000);
    }
}

// Initialize
const app = new ChurchManagementApp();
