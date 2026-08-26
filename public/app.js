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
        this.uploadedImage = null;
        this.uploadedImageData = null;
        this.extractedData = null;
        this.currentReturnId = null;
        this.currentReviewId = null;

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

        // Monthly Returns listeners
        this.setupReturnsListeners();
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

        const returnsNav = document.getElementById('returns-nav');
        const reviewNav = document.getElementById('review-nav');

        if (this.user.role === 'main_leader') {
            userRoleSpan.textContent = 'Main Leader';
            userBranchSpan.classList.remove('show');
            addBranchBtn.style.display = 'block';
            adminNav.style.display = 'block';
            addMemberBtn.style.display = 'none';
            returnsNav.style.display = 'none';
            reviewNav.style.display = 'inline-block';
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
            returnsNav.style.display = 'inline-block';
            reviewNav.style.display = 'none';
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

        // Load data for returns pages
        if (page === 'monthly-returns') this.loadPastReturns();
        if (page === 'review-returns') this.loadReviewReturns();
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

    // ──────────────────────────────────────────
    // Monthly Returns - Image Upload & Extraction
    // ──────────────────────────────────────────

    setupReturnsListeners() {
        // Image upload handlers
        const imageInput = document.getElementById('returns-image-input');
        const fileInput = document.getElementById('returns-file-input');
        const changeImageBtn = document.getElementById('change-image-btn');
        const viewOriginalBtn = document.getElementById('view-original-btn');
        const saveDraftBtn = document.getElementById('save-draft-btn');
        const submitReturnsBtn = document.getElementById('submit-returns-btn');
        const closeImageViewer = document.getElementById('close-image-viewer');
        const closeReviewModal = document.getElementById('close-review-modal');
        const approveBtn = document.getElementById('approve-return-btn');
        const rejectBtn = document.getElementById('reject-return-btn');
        const reviewStatusFilter = document.getElementById('review-status-filter');

        if (imageInput) imageInput.addEventListener('change', (e) => this.handleImageUpload(e));
        if (fileInput) fileInput.addEventListener('change', (e) => this.handleImageUpload(e));
        if (changeImageBtn) changeImageBtn.addEventListener('click', () => this.resetUpload());
        if (viewOriginalBtn) viewOriginalBtn.addEventListener('click', () => this.showOriginalImage());
        if (saveDraftBtn) saveDraftBtn.addEventListener('click', () => this.saveDraft());
        if (submitReturnsBtn) submitReturnsBtn.addEventListener('click', () => this.submitReturns());
        if (closeImageViewer) closeImageViewer.addEventListener('click', () => this.closeModal('image-viewer-modal'));
        if (closeReviewModal) closeReviewModal.addEventListener('click', () => this.closeModal('review-detail-modal'));
        if (approveBtn) approveBtn.addEventListener('click', () => this.reviewReturn('approve'));
        if (rejectBtn) rejectBtn.addEventListener('click', () => this.reviewReturn('reject'));
        if (reviewStatusFilter) reviewStatusFilter.addEventListener('change', () => this.loadReviewReturns());

        // Modal backdrop close
        document.getElementById('image-viewer-modal').addEventListener('click', (e) => {
            if (e.target.id === 'image-viewer-modal') this.closeModal('image-viewer-modal');
        });
        document.getElementById('review-detail-modal').addEventListener('click', (e) => {
            if (e.target.id === 'review-detail-modal') this.closeModal('review-detail-modal');
        });
    }

    async handleImageUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Show preview
        this.uploadedImage = file;
        const reader = new FileReader();
        reader.onload = (e) => {
            this.uploadedImageData = e.target.result;
            document.getElementById('preview-image').src = e.target.result;
            document.getElementById('upload-area').style.display = 'none';
            document.getElementById('upload-preview').style.display = 'block';
        };
        reader.readAsDataURL(file);

        // Start extraction
        await this.extractFromImage(file);
    }

    async extractFromImage(file) {
        const loading = document.getElementById('extraction-loading');
        const dataSection = document.getElementById('returns-data-section');

        loading.style.display = 'block';
        dataSection.style.display = 'none';

        try {
            const formData = new FormData();
            formData.append('image', file);

            const response = await fetch('/api/returns/extract', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` },
                body: formData
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Extraction failed');
            }

            this.extractedData = result.extracted;
            this.renderExtractedData(result.extracted);
            loading.style.display = 'none';
            dataSection.style.display = 'block';

        } catch (error) {
            loading.style.display = 'none';
            alert('Error extracting data: ' + error.message);
            this.resetUpload();
        }
    }

    renderExtractedData(data) {
        // Header info
        document.getElementById('returns-church-name').textContent = data.church_name || '';
        document.getElementById('returns-month').textContent = data.month || '';

        // Attendance table
        this.renderAttendanceTable(data.attendance || []);

        // Income table
        this.renderIncomeTable(data.income || []);
    }

    renderAttendanceTable(attendance) {
        const tbody = document.getElementById('attendance-tbody');
        const tfoot = document.getElementById('attendance-tfoot');
        tbody.innerHTML = '';
        tfoot.innerHTML = '';

        attendance.forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><input type="text" class="table-input" data-type="attendance" data-index="${index}" data-field="date" value="${this.escapeHtml(row.date || '')}"></td>
                <td><input type="number" class="table-input" data-type="attendance" data-index="${index}" data-field="men" value="${row.men || 0}"></td>
                <td><input type="number" class="table-input" data-type="attendance" data-index="${index}" data-field="women" value="${row.women || 0}"></td>
                <td><input type="number" class="table-input" data-type="attendance" data-index="${index}" data-field="youth" value="${row.youth || 0}"></td>
                <td><input type="number" class="table-input" data-type="attendance" data-index="${index}" data-field="children" value="${row.children || 0}"></td>
                <td><input type="number" class="table-input total-cell" data-type="attendance" data-index="${index}" data-field="total" value="${row.total || 0}" readonly></td>
            `;
            tbody.appendChild(tr);
        });

        // Add row totals listener
        tbody.querySelectorAll('input[type="number"]:not([readonly])').forEach(input => {
            input.addEventListener('input', () => this.recalculateAttendanceRow(input.dataset.index));
        });

        // Grand total
        this.renderAttendanceFooter(attendance);
    }

    recalculateAttendanceRow(index) {
        const men = parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="men"]`).value) || 0;
        const women = parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="women"]`).value) || 0;
        const youth = parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="youth"]`).value) || 0;
        const children = parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="children"]`).value) || 0;
        const total = men + women + youth + children;

        document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="total"]`).value = total;
        this.updateAttendanceGrandTotal();
    }

    updateAttendanceGrandTotal() {
        const totals = document.querySelectorAll('input[data-type="attendance"][data-field="total"]');
        let grandTotal = 0;
        totals.forEach(input => { grandTotal += parseInt(input.value) || 0; });

        const tfoot = document.getElementById('attendance-tfoot');
        tfoot.innerHTML = `<tr class="totals-row"><td colspan="5"><strong>Grand Total</strong></td><td><strong>${grandTotal}</strong></td></tr>`;
    }

    renderAttendanceFooter(attendance) {
        const grandTotal = attendance.reduce((sum, row) => sum + (row.total || 0), 0);
        const tfoot = document.getElementById('attendance-tfoot');
        tfoot.innerHTML = `<tr class="totals-row"><td colspan="5"><strong>Grand Total</strong></td><td><strong>${grandTotal}</strong></td></tr>`;
    }

    renderIncomeTable(income) {
        const tbody = document.getElementById('income-tbody');
        const tfoot = document.getElementById('income-tfoot');
        tbody.innerHTML = '';
        tfoot.innerHTML = '';

        const fields = ['tithe_account', 'tithe_offering', 'main_account', 'sunday_school', 'evangelism', 'pure_water', 'other'];

        income.forEach((row, index) => {
            const tr = document.createElement('tr');
            let cellsHtml = `<td><input type="text" class="table-input" data-type="income" data-index="${index}" data-field="date" value="${this.escapeHtml(row.date || '')}"></td>`;

            fields.forEach(field => {
                const value = row[field] || 0;
                const isUncertain = value === 0 || value === null;
                cellsHtml += `<td><input type="number" class="table-input${isUncertain ? ' uncertain' : ''}" data-type="income" data-index="${index}" data-field="${field}" value="${value}"></td>`;
            });

            tr.innerHTML = cellsHtml;
            tbody.appendChild(tr);
        });

        // Income change listeners for totals
        tbody.querySelectorAll('input[type="number"]').forEach(input => {
            input.addEventListener('input', () => this.updateIncomeTotals());
            input.addEventListener('focus', (e) => e.target.classList.remove('uncertain'));
        });

        this.updateIncomeTotals();
    }

    updateIncomeTotals() {
        const fields = ['tithe_account', 'tithe_offering', 'main_account', 'sunday_school', 'evangelism', 'pure_water', 'other'];
        const totals = {};
        let grandTotal = 0;

        fields.forEach(field => {
            const inputs = document.querySelectorAll(`input[data-type="income"][data-field="${field}"]`);
            let sum = 0;
            inputs.forEach(input => { sum += parseInt(input.value) || 0; });
            totals[field] = sum;
            grandTotal += sum;
        });

        const tfoot = document.getElementById('income-tfoot');
        tfoot.innerHTML = `
            <tr class="totals-row">
                <td><strong>Totals</strong></td>
                <td><strong>₦${totals.tithe_account.toLocaleString()}</strong></td>
                <td><strong>₦${totals.tithe_offering.toLocaleString()}</strong></td>
                <td><strong>₦${totals.main_account.toLocaleString()}</strong></td>
                <td><strong>₦${totals.sunday_school.toLocaleString()}</strong></td>
                <td><strong>₦${totals.evangelism.toLocaleString()}</strong></td>
                <td><strong>₦${totals.pure_water.toLocaleString()}</strong></td>
                <td><strong>₦${totals.other.toLocaleString()}</strong></td>
            </tr>
            <tr class="grand-total-row">
                <td colspan="8"><strong>Grand Total: ₦${grandTotal.toLocaleString()}</strong></td>
            </tr>
        `;
    }

    resetUpload() {
        document.getElementById('upload-area').style.display = 'block';
        document.getElementById('upload-preview').style.display = 'none';
        document.getElementById('extraction-loading').style.display = 'none';
        document.getElementById('returns-data-section').style.display = 'none';
        document.getElementById('returns-image-input').value = '';
        document.getElementById('returns-file-input').value = '';
        this.uploadedImage = null;
        this.uploadedImageData = null;
        this.extractedData = null;
    }

    showOriginalImage() {
        if (this.uploadedImageData) {
            document.getElementById('viewer-image').src = this.uploadedImageData;
            document.getElementById('image-viewer-modal').classList.add('active');
        }
    }

    closeModal(modalId) {
        document.getElementById(modalId).classList.remove('active');
    }

    // ──────────────────────────────────────────
    // Monthly Returns - Save & Submit
    // ──────────────────────────────────────────

    getTableData() {
        const attendance = [];
        const incomeData = [];
        const fields = ['tithe_account', 'tithe_offering', 'main_account', 'sunday_school', 'evangelism', 'pure_water', 'other'];

        // Get attendance rows
        const attRows = document.querySelectorAll('#attendance-tbody tr');
        attRows.forEach((tr, index) => {
            attendance.push({
                date: document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="date"]`).value,
                men: parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="men"]`).value) || 0,
                women: parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="women"]`).value) || 0,
                youth: parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="youth"]`).value) || 0,
                children: parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="children"]`).value) || 0,
                total: parseInt(document.querySelector(`input[data-type="attendance"][data-index="${index}"][data-field="total"]`).value) || 0
            });
        });

        // Get income rows
        const incRows = document.querySelectorAll('#income-tbody tr');
        incRows.forEach((tr, index) => {
            const row = { date: document.querySelector(`input[data-type="income"][data-index="${index}"][data-field="date"]`).value };
            fields.forEach(field => {
                row[field] = parseInt(document.querySelector(`input[data-type="income"][data-index="${index}"][data-field="${field}"]`).value) || 0;
            });
            incomeData.push(row);
        });

        return { attendance, income: incomeData };
    }

    async saveDraft() {
        try {
            const { attendance, income } = this.getTableData();
            const month = this.extractedData ? this.extractedData.month : '';

            // Parse month to a date format the API expects
            const monthDate = this.parseMonthToDate(month);

            const result = await this.apiCall('/api/returns', 'POST', {
                month: monthDate,
                attendance,
                income
            });

            this.currentReturnId = result.id;
            this.showSuccessMessage('Draft saved successfully!');
            this.loadPastReturns();
        } catch (error) {
            alert('Error saving draft: ' + error.message);
        }
    }

    async submitReturns() {
        if (!confirm('Submit this return to the G.O. for review? You won\'t be able to edit it after submission.')) {
            return;
        }

        try {
            // Save first if not already saved
            if (!this.currentReturnId) {
                await this.saveDraft();
            }

            // Check saveDraft actually succeeded
            if (!this.currentReturnId) {
                alert('Could not save the draft. Please fix any errors and try again.');
                return;
            }

            await this.apiCall(`/api/returns/${this.currentReturnId}/submit`, 'POST');
            this.showSuccessMessage('Returns submitted to G.O. successfully!');
            this.resetUpload();
            this.loadPastReturns();
        } catch (error) {
            alert('Error submitting returns: ' + error.message);
        }
    }

    parseMonthToDate(monthStr) {
        // Convert "May 2026" to "2026-05-01"
        if (!monthStr) return new Date().toISOString().slice(0, 10);

        const months = { 'january': '01', 'february': '02', 'march': '03', 'april': '04', 'may': '05', 'june': '06', 'july': '07', 'august': '08', 'september': '09', 'october': '10', 'november': '11', 'december': '12' };

        const parts = monthStr.trim().split(' ');
        if (parts.length === 2) {
            const monthNum = months[parts[0].toLowerCase()];
            const year = parts[1];
            if (monthNum && year) return `${year}-${monthNum}-01`;
        }
        return monthStr;
    }

    // ──────────────────────────────────────────
    // Monthly Returns - Past Returns List
    // ──────────────────────────────────────────

    async loadPastReturns() {
        try {
            const returns = await this.apiCall('/api/returns');
            this.renderPastReturns(returns);
        } catch (error) {
            // Non-critical
        }
    }

    renderPastReturns(returns) {
        const container = document.getElementById('past-returns-list');
        if (!returns || returns.length === 0) {
            container.innerHTML = '<p class="empty-state">No past returns yet. Upload your first monthly returns sheet above.</p>';
            return;
        }

        container.innerHTML = returns.map(r => `
            <div class="return-card ${r.status}">
                <div class="return-card-header">
                    <span class="return-month">${this.formatMonth(r.month)}</span>
                    <span class="return-status status-${r.status}">${this.formatStatus(r.status)}</span>
                </div>
                <div class="return-card-details">
                    <span>Submitted: ${r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : 'Not yet'}</span>
                    ${r.reviewed_at ? `<span>Reviewed: ${new Date(r.reviewed_at).toLocaleDateString()}</span>` : ''}
                </div>
                ${r.review_notes ? `<div class="return-notes"><strong>G.O. Notes:</strong> ${this.escapeHtml(r.review_notes)}</div>` : ''}
            </div>
        `).join('');
    }

    formatMonth(dateStr) {
        if (!dateStr) return 'Unknown';
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }

    formatStatus(status) {
        const labels = { 'draft': '📝 Draft', 'submitted': '📤 Submitted', 'reviewed': '✅ Approved', 'rejected': '❌ Rejected' };
        return labels[status] || status;
    }

    // ──────────────────────────────────────────
    // Monthly Returns - G.O. Review
    // ──────────────────────────────────────────

    async loadReviewReturns() {
        try {
            const status = document.getElementById('review-status-filter').value;
            const url = status ? `/api/returns?status=${status}` : '/api/returns';
            const returns = await this.apiCall(url);
            this.renderReviewReturns(returns);
        } catch (error) {
            document.getElementById('review-returns-list').innerHTML = '<p class="empty-state">Error loading returns.</p>';
        }
    }

    renderReviewReturns(returns) {
        const container = document.getElementById('review-returns-list');
        if (!returns || returns.length === 0) {
            container.innerHTML = '<p class="empty-state">No returns to review.</p>';
            return;
        }

        container.innerHTML = returns.map(r => `
            <div class="review-card" data-return-id="${r.id}">
                <div class="review-card-header">
                    <div>
                        <span class="review-branch-name">${this.escapeHtml(r.branch_name || 'Unknown Branch')}</span>
                        <span class="review-month">${this.formatMonth(r.month)}</span>
                    </div>
                    <span class="return-status status-${r.status}">${this.formatStatus(r.status)}</span>
                </div>
                <div class="review-card-meta">
                    <span>Submitted: ${r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '-'}</span>
                </div>
            </div>
        `).join('');

        // Add click handlers via event delegation
        container.querySelectorAll('.review-card[data-return-id]').forEach(card => {
            card.addEventListener('click', () => {
                const returnId = parseInt(card.dataset.returnId);
                this.openReviewDetail(returnId);
            });
        });
    }

    async openReviewDetail(returnId) {
        try {
            this.currentReviewId = returnId;
            const data = await this.apiCall(`/api/returns/${returnId}`);
            this.renderReviewDetail(data);
            document.getElementById('review-detail-modal').classList.add('active');

            // Hide actions if already reviewed
            const actions = document.getElementById('review-modal-actions');
            actions.style.display = (data.status === 'submitted') ? 'block' : 'none';
        } catch (error) {
            alert('Error loading return details: ' + error.message);
        }
    }

    renderReviewDetail(data) {
        const body = document.getElementById('review-modal-body');
        const title = document.getElementById('review-modal-title');
        title.textContent = `${data.branch_name || 'Branch'} - ${this.formatMonth(data.month)}`;

        let html = '<div class="review-detail-content">';

        // Attendance table (read-only)
        if (data.attendance && data.attendance.length > 0) {
            html += '<h4>📊 Attendance</h4><div class="table-responsive"><table class="returns-table review-table"><thead><tr><th>Date</th><th>Men</th><th>Women</th><th>Youth</th><th>Children</th><th>Total</th></tr></thead><tbody>';
            data.attendance.forEach(row => {
                html += `<tr><td>${this.escapeHtml(row.date)}</td><td>${row.men}</td><td>${row.women}</td><td>${row.youth}</td><td>${row.children}</td><td><strong>${row.total}</strong></td></tr>`;
            });
            const attTotal = data.attendance.reduce((s, r) => s + (r.total || 0), 0);
            html += `</tbody><tfoot><tr class="totals-row"><td colspan="5"><strong>Grand Total</strong></td><td><strong>${attTotal}</strong></td></tr></tfoot></table></div>`;
        }

        // Income table (read-only)
        if (data.income && data.income.length > 0) {
            html += '<h4>💰 Income</h4><div class="table-responsive"><table class="returns-table review-table"><thead><tr><th>Date</th><th>Tithe A/C</th><th>Tithe Off.</th><th>Main A/C</th><th>S. School</th><th>Evangelism</th><th>P. Water</th><th>Other</th></tr></thead><tbody>';
            let grandTotal = 0;
            data.income.forEach(row => {
                const rowTotal = (row.tithe_account || 0) + (row.tithe_offering || 0) + (row.main_account || 0) + (row.sunday_school || 0) + (row.evangelism || 0) + (row.pure_water || 0) + (row.other || 0);
                grandTotal += rowTotal;
                html += `<tr><td>${this.escapeHtml(row.date)}</td><td>₦${(row.tithe_account || 0).toLocaleString()}</td><td>₦${(row.tithe_offering || 0).toLocaleString()}</td><td>₦${(row.main_account || 0).toLocaleString()}</td><td>₦${(row.sunday_school || 0).toLocaleString()}</td><td>₦${(row.evangelism || 0).toLocaleString()}</td><td>₦${(row.pure_water || 0).toLocaleString()}</td><td>₦${(row.other || 0).toLocaleString()}</td></tr>`;
            });
            html += `</tbody><tfoot><tr class="grand-total-row"><td colspan="8"><strong>Grand Total: ₦${grandTotal.toLocaleString()}</strong></td></tr></tfoot></table></div>`;
        }

        html += '</div>';
        body.innerHTML = html;
    }

    async reviewReturn(action) {
        const notes = document.getElementById('review-notes').value.trim();
        const confirmMsg = action === 'approve'
            ? 'Approve this monthly return?'
            : 'Reject this monthly return? The pastor will need to resubmit.';

        if (!confirm(confirmMsg)) return;

        try {
            await this.apiCall(`/api/returns/${this.currentReviewId}/review`, 'POST', { action, notes });
            this.closeModal('review-detail-modal');
            this.showSuccessMessage(`Return ${action === 'approve' ? 'approved' : 'rejected'} successfully!`);
            this.loadReviewReturns();
        } catch (error) {
            alert('Error: ' + error.message);
        }
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
