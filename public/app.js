class ChurchManagementApp {
    constructor() {
        this.token = localStorage.getItem('token');
        this.user = null;
        this.branches = [];
        this.members = [];
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

    setupEventListeners() {
        // Login form
        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.login();
        });

        // Logout
        document.getElementById('logout-btn').addEventListener('click', () => {
            this.logout();
        });

        // Navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.switchPage(e.target.dataset.page);
            });
        });

        // Member modal
        document.getElementById('add-member-btn').addEventListener('click', () => {
            this.openMemberModal();
        });
        
        document.getElementById('close-member-modal').addEventListener('click', () => {
            this.closeMemberModal();
        });
        
        document.getElementById('cancel-member').addEventListener('click', () => {
            this.closeMemberModal();
        });

        // Branch modal
        document.getElementById('add-branch-btn').addEventListener('click', () => {
            this.openBranchModal();
        });
        
        document.getElementById('close-branch-modal').addEventListener('click', () => {
            this.closeBranchModal();
        });
        
        document.getElementById('cancel-branch').addEventListener('click', () => {
            this.closeBranchModal();
        });

        // Forms
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

        // Branch selection change handler
        document.getElementById('pastor-branch').addEventListener('change', (e) => {
            this.handleBranchSelection(e.target.value);
        });

        // Cancel new branch
        document.getElementById('cancel-new-branch').addEventListener('click', () => {
            this.cancelNewBranch();
        });

        // Password validation
        document.getElementById('pastor-password').addEventListener('input', () => {
            this.validatePasswords();
        });
        
        document.getElementById('pastor-confirm-password').addEventListener('input', () => {
            this.validatePasswords();
        });

        // Worker checkbox
        document.getElementById('member-is-worker').addEventListener('change', (e) => {
            const departmentGroup = document.getElementById('worker-department-group');
            departmentGroup.style.display = e.target.checked ? 'block' : 'none';
        });

        // Search and filter
        document.getElementById('member-search').addEventListener('input', () => {
            this.renderMembers();
        });
        
        document.getElementById('branch-filter').addEventListener('change', () => {
            this.renderMembers();
        });

        // Close modals on outside click
        document.getElementById('member-modal').addEventListener('click', (e) => {
            if (e.target.id === 'member-modal') {
                this.closeMemberModal();
            }
        });
        
        document.getElementById('branch-modal').addEventListener('click', (e) => {
            if (e.target.id === 'branch-modal') {
                this.closeBranchModal();
            }
        });
    }

    // Authentication
    async login() {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('login-error');

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
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
            headers: {
                'Authorization': `Bearer ${this.token}`
            }
        });

        if (!response.ok) {
            throw new Error('Invalid token');
        }

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
        
        // Update UI based on user role
        this.updateUIForRole();
    }

    updateUIForRole() {
        const userRoleSpan = document.getElementById('user-role');
        const userBranchSpan = document.getElementById('user-branch');
        const addMemberBtn = document.getElementById('add-member-btn');
        const addBranchBtn = document.getElementById('add-branch-btn');
        const branchesNav = document.getElementById('branches-nav');
        const adminNav = document.getElementById('admin-nav');

        if (this.user.role === 'main_leader') {
            userRoleSpan.textContent = 'Main Leader';
            userBranchSpan.classList.remove('show');
            addBranchBtn.style.display = 'block';
            adminNav.style.display = 'block';
            addMemberBtn.style.display = 'none'; // Main leader doesn't add members directly
            
            // Update page title
            document.title = 'Church Management System - Main Leader';
        } else if (this.user.role === 'branch_pastor') {
            userRoleSpan.textContent = 'Branch Pastor';
            
            // Show branch name if available
            if (this.user.branch_name) {
                userBranchSpan.textContent = this.user.branch_name;
                userBranchSpan.classList.add('show');
                
                // Update page title to include branch name
                document.title = `Church Management - ${this.user.branch_name}`;
            }
            
            addMemberBtn.style.display = 'block';
            addBranchBtn.style.display = 'none';
            adminNav.style.display = 'none';
        }
    }

    // Data loading
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
            headers: {
                'Authorization': `Bearer ${this.token}`
            }
        });
        
        if (response.ok) {
            this.branches = await response.json();
        }
    }

    async loadMembers() {
        const response = await fetch('/api/members', {
            headers: {
                'Authorization': `Bearer ${this.token}`
            }
        });
        
        if (response.ok) {
            this.members = await response.json();
        }
    }

    async loadStats() {
        try {
            const response = await fetch('/api/stats', {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            
            if (response.ok) {
                this.stats = await response.json();
                console.log('Stats loaded:', this.stats); // Debug log
            } else {
                console.error('Failed to load stats:', response.status, response.statusText);
            }
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }

    // API calls
    async apiCall(url, method = 'GET', data = null) {
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            }
        };

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(url, options);
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Request failed');
        }

        return response.json();
    }

    switchPage(page) {
        // Update navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-page="${page}"]`).classList.add('active');

        // Update pages
        document.querySelectorAll('.page').forEach(p => {
            p.classList.remove('active');
        });
        document.getElementById(page).classList.add('active');
    }   
 // Branch Management
    openBranchModal(branch = null) {
        this.currentEditingBranch = branch;
        const modal = document.getElementById('branch-modal');
        const title = document.getElementById('branch-modal-title');
        const form = document.getElementById('branch-form');
        
        if (branch) {
            title.textContent = 'Edit Branch';
            document.getElementById('branch-name').value = branch.name;
            document.getElementById('branch-address').value = branch.address || '';
            document.getElementById('branch-pastor').value = branch.pastor_name || '';
        } else {
            title.textContent = 'Add Branch';
            form.reset();
        }
        
        modal.classList.add('active');
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
                await this.apiCall(`/api/branches/${this.currentEditingBranch.id}`, 'PUT', {
                    name, address, pastor_name
                });
            } else {
                await this.apiCall('/api/branches', 'POST', {
                    name, address, pastor_name
                });
            }

            await this.loadData();
            this.closeBranchModal();
            this.showSuccessMessage('Branch saved successfully');
        } catch (error) {
            alert('Error saving branch: ' + error.message);
        }
    }

    // Member Management
    openMemberModal(member = null) {
        this.currentEditingMember = member;
        const modal = document.getElementById('member-modal');
        const title = document.getElementById('member-modal-title');
        const form = document.getElementById('member-form');
        const departmentGroup = document.getElementById('worker-department-group');
        
        if (member) {
            title.textContent = 'Edit Member';
            document.getElementById('member-name').value = member.name;
            document.getElementById('member-address').value = member.address || '';
            document.getElementById('member-workplace').value = member.workplace || '';
            document.getElementById('member-occupation').value = member.occupation || '';
            document.getElementById('member-join-date').value = member.join_date || '';
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
        
        modal.classList.add('active');
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
            branch_id: this.user.branch_id, // Pastor can only add to their branch
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

    // Admin functions
    handleBranchSelection(value) {
        const newBranchSection = document.getElementById('new-branch-section');
        const newBranchName = document.getElementById('new-branch-name');
        const newBranchPastorName = document.getElementById('new-branch-pastor-name');
        const username = document.getElementById('pastor-username').value.trim();

        if (value === 'create-new') {
            newBranchSection.style.display = 'block';
            newBranchName.required = true;
            // Auto-fill pastor name from username
            if (username) {
                newBranchPastorName.value = username;
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
        
        // Remove existing feedback
        const existingFeedback = confirmField.parentNode.querySelector('.password-feedback');
        if (existingFeedback) {
            existingFeedback.remove();
        }
        
        // Reset classes
        confirmField.classList.remove('password-match', 'password-mismatch');
        
        if (confirmPassword.length === 0) {
            return; // Don't show feedback for empty field
        }
        
        const feedback = document.createElement('div');
        feedback.className = 'password-feedback';
        
        if (password === confirmPassword) {
            if (password.length >= 6) {
                confirmField.classList.add('password-match');
                feedback.classList.add('match');
                feedback.textContent = '✓ Passwords match';
            } else {
                feedback.classList.add('weak');
                feedback.textContent = '⚠ Password should be at least 6 characters';
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
        if (existingFeedback) {
            existingFeedback.remove();
        }
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
            alert('Passwords do not match. Please try again.');
            return;
        }

        if (password.length < 6) {
            alert('Password must be at least 6 characters long');
            return;
        }

        try {
            let branch_id;

            // Check if we need to create a new branch first
            if (branchSelection === 'create-new') {
                const branchName = document.getElementById('new-branch-name').value.trim();
                const branchAddress = document.getElementById('new-branch-address').value.trim();
                const pastorName = document.getElementById('new-branch-pastor-name').value.trim() || username;

                if (!branchName) {
                    alert('Branch name is required when creating a new branch');
                    return;
                }

                // Create the new branch first
                const newBranch = await this.apiCall('/api/branches', 'POST', {
                    name: branchName,
                    address: branchAddress,
                    pastor_name: pastorName
                });

                branch_id = newBranch.id;
                
                // Reload branches to update the dropdown
                await this.loadBranches();
                this.updateBranchSelects();
            } else {
                branch_id = parseInt(branchSelection);
            }

            // Create the pastor account
            await this.apiCall('/api/create-pastor', 'POST', {
                username, password, branch_id
            });

            // Reload all data to refresh the dashboard
            console.log('Reloading data after pastor account creation...');
            await this.loadData();
            console.log('Data reloaded, stats:', this.stats);

            // Reset the form
            document.getElementById('create-pastor-form').reset();
            this.cancelNewBranch();
            this.clearPasswordValidation();
            
            this.showSuccessMessage('Pastor account created successfully' + 
                (branchSelection === 'create-new' ? ' (new branch created)' : ''));
        } catch (error) {
            alert('Error creating pastor account: ' + error.message);
        }
    }

    // Rendering Methods
    renderDashboard() {
        console.log('Rendering dashboard, stats:', this.stats); // Debug log
        
        if (!this.stats) {
            console.log('No stats available for dashboard');
            return;
        }

        document.getElementById('total-members').textContent = this.stats.total_members;
        document.getElementById('total-branches').textContent = this.stats.total_branches;

        const branchesContainer = document.getElementById('branches-list');
        branchesContainer.innerHTML = '';

        if (!this.stats.branches || this.stats.branches.length === 0) {
            branchesContainer.innerHTML = '<div style="text-align: center; padding: 2rem; color: #7f8c8d;">No branches found</div>';
            return;
        }

        this.stats.branches.forEach(branch => {
            const branchCard = document.createElement('div');
            branchCard.className = 'branch-card';
            branchCard.innerHTML = `
                <h4>${branch.name}</h4>
                <div class="branch-info">📍 ${branch.address || 'No address provided'}</div>
                <div class="branch-info">👨‍💼 Pastor: ${branch.pastor_name || 'Not assigned'}</div>
                <span class="member-count">${branch.member_count} members</span>
            `;
            
            if (this.user.role === 'main_leader') {
                branchCard.addEventListener('click', () => {
                    this.switchPage('members');
                    document.getElementById('branch-filter').value = branch.id;
                    this.renderMembers();
                });
            }
            
            branchesContainer.appendChild(branchCard);
        });
    }

    renderMembers() {
        const searchTerm = document.getElementById('member-search').value.toLowerCase();
        const branchFilter = document.getElementById('branch-filter').value;
        
        let filteredMembers = this.members;
        
        if (searchTerm) {
            filteredMembers = filteredMembers.filter(member => 
                member.name.toLowerCase().includes(searchTerm) ||
                (member.occupation && member.occupation.toLowerCase().includes(searchTerm)) ||
                (member.department && member.department.toLowerCase().includes(searchTerm)) ||
                (member.phone && member.phone.includes(searchTerm)) ||
                (member.email && member.email.toLowerCase().includes(searchTerm))
            );
        }
        
        if (branchFilter) {
            filteredMembers = filteredMembers.filter(member => 
                member.branch_id === parseInt(branchFilter)
            );
        }

        const membersContainer = document.getElementById('members-list');
        membersContainer.innerHTML = '';

        if (filteredMembers.length === 0) {
            membersContainer.innerHTML = '<div style="text-align: center; padding: 2rem; color: #7f8c8d;">No members found</div>';
            return;
        }

        filteredMembers.forEach(member => {
            const memberCard = document.createElement('div');
            memberCard.className = 'member-card';
            memberCard.innerHTML = `
                <div class="member-header">
                    <div class="member-name">${member.name}</div>
                    <div class="member-branch">${member.branch_name}</div>
                </div>
                <div class="member-details">
                    ${member.phone ? `<div class="member-detail">📞 ${member.phone}</div>` : ''}
                    ${member.email ? `<div class="member-detail">✉️ ${member.email}</div>` : ''}
                    ${member.occupation ? `<div class="member-detail">💼 ${member.occupation}</div>` : ''}
                    ${member.workplace ? `<div class="member-detail">🏢 ${member.workplace}</div>` : ''}
                    ${member.address ? `<div class="member-detail">🏠 ${member.address}</div>` : ''}
                    ${member.join_date ? `<div class="member-detail">📅 Joined: ${new Date(member.join_date).toLocaleDateString()}</div>` : ''}
                </div>
                ${member.is_worker ? `<div class="worker-badge">⭐ ${member.department || 'Church Worker'}</div>` : ''}
                ${this.user.role === 'branch_pastor' ? `
                    <div class="member-actions">
                        <button class="btn-secondary" onclick="app.openMemberModal(${JSON.stringify(member).replace(/"/g, '&quot;')})">Edit</button>
                        <button class="btn-danger" onclick="app.deleteMember(${member.id})">Delete</button>
                    </div>
                ` : ''}
            `;
            membersContainer.appendChild(memberCard);
        });
    }

    renderBranches() {
        const branchesContainer = document.getElementById('branches-grid');
        branchesContainer.innerHTML = '';

        if (this.branches.length === 0) {
            branchesContainer.innerHTML = '<div style="text-align: center; padding: 2rem; color: #7f8c8d;">No branches added yet</div>';
            return;
        }

        this.branches.forEach(branch => {
            const memberCount = this.members.filter(m => m.branch_id === branch.id).length;
            const branchCard = document.createElement('div');
            branchCard.className = 'branch-card';
            branchCard.innerHTML = `
                <h4>${branch.name}</h4>
                <div class="branch-info">📍 ${branch.address || 'No address provided'}</div>
                <div class="branch-info">👨‍💼 Pastor: ${branch.pastor_name || 'Not assigned'}</div>
                <span class="member-count">${memberCount} members</span>
                ${this.user.role === 'main_leader' ? `
                    <div style="margin-top: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
                        <button class="btn-secondary" onclick="app.openBranchModal(${JSON.stringify(branch).replace(/"/g, '&quot;')})">Edit</button>
                        <button class="btn-primary" onclick="app.viewBranchMembers(${branch.id})">View Members</button>
                    </div>
                ` : ''}
            `;
            branchesContainer.appendChild(branchCard);
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
            
            if (isFilter) {
                select.innerHTML = '<option value="">All Branches</option>';
            } else if (isPastorBranch) {
                select.innerHTML = '<option value="">Select Branch</option>';
            }
            
            this.branches.forEach(branch => {
                const option = document.createElement('option');
                option.value = branch.id;
                option.textContent = branch.name;
                select.appendChild(option);
            });

            // Add "Create New Branch" option for pastor branch select
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
        // Create a temporary success message
        const successDiv = document.createElement('div');
        successDiv.className = 'success-message show';
        successDiv.textContent = message;
        
        const main = document.querySelector('.main');
        main.insertBefore(successDiv, main.firstChild);
        
        setTimeout(() => {
            successDiv.remove();
        }, 3000);
    }
}

// Initialize the app
const app = new ChurchManagementApp();