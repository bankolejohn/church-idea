class ChurchManagementApp {
    constructor() {
        this.branches = JSON.parse(localStorage.getItem('branches')) || [];
        this.members = JSON.parse(localStorage.getItem('members')) || [];
        this.currentEditingMember = null;
        this.currentEditingBranch = null;
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.renderDashboard();
        this.renderMembers();
        this.renderBranches();
        this.updateBranchSelects();
    }

    setupEventListeners() {
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
            document.getElementById('branch-address').value = branch.address;
            document.getElementById('branch-pastor').value = branch.pastor;
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

    saveBranch() {
        const name = document.getElementById('branch-name').value.trim();
        const address = document.getElementById('branch-address').value.trim();
        const pastor = document.getElementById('branch-pastor').value.trim();

        if (!name) {
            alert('Branch name is required');
            return;
        }

        const branchData = {
            id: this.currentEditingBranch ? this.currentEditingBranch.id : Date.now(),
            name,
            address,
            pastor
        };

        if (this.currentEditingBranch) {
            const index = this.branches.findIndex(b => b.id === this.currentEditingBranch.id);
            this.branches[index] = branchData;
        } else {
            this.branches.push(branchData);
        }

        this.saveToStorage();
        this.renderDashboard();
        this.renderBranches();
        this.updateBranchSelects();
        this.closeBranchModal();
    }

    deleteBranch(branchId) {
        if (confirm('Are you sure you want to delete this branch? This will also remove all members from this branch.')) {
            this.branches = this.branches.filter(b => b.id !== branchId);
            this.members = this.members.filter(m => m.branchId !== branchId);
            this.saveToStorage();
            this.renderDashboard();
            this.renderBranches();
            this.renderMembers();
            this.updateBranchSelects();
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
            document.getElementById('member-join-date').value = member.joinDate || '';
            document.getElementById('member-branch').value = member.branchId;
            document.getElementById('member-is-worker').checked = member.isWorker || false;
            document.getElementById('member-department').value = member.department || '';
            document.getElementById('member-phone').value = member.phone || '';
            document.getElementById('member-email').value = member.email || '';
            
            departmentGroup.style.display = member.isWorker ? 'block' : 'none';
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

    saveMember() {
        const name = document.getElementById('member-name').value.trim();
        const branchId = document.getElementById('member-branch').value;

        if (!name || !branchId) {
            alert('Name and branch are required');
            return;
        }

        const memberData = {
            id: this.currentEditingMember ? this.currentEditingMember.id : Date.now(),
            name,
            address: document.getElementById('member-address').value.trim(),
            workplace: document.getElementById('member-workplace').value.trim(),
            occupation: document.getElementById('member-occupation').value.trim(),
            joinDate: document.getElementById('member-join-date').value,
            branchId: parseInt(branchId),
            isWorker: document.getElementById('member-is-worker').checked,
            department: document.getElementById('member-department').value.trim(),
            phone: document.getElementById('member-phone').value.trim(),
            email: document.getElementById('member-email').value.trim()
        };

        if (this.currentEditingMember) {
            const index = this.members.findIndex(m => m.id === this.currentEditingMember.id);
            this.members[index] = memberData;
        } else {
            this.members.push(memberData);
        }

        this.saveToStorage();
        this.renderDashboard();
        this.renderMembers();
        this.closeMemberModal();
    }

    deleteMember(memberId) {
        if (confirm('Are you sure you want to delete this member?')) {
            this.members = this.members.filter(m => m.id !== memberId);
            this.saveToStorage();
            this.renderDashboard();
            this.renderMembers();
        }
    }

    // Rendering Methods
    renderDashboard() {
        document.getElementById('total-members').textContent = this.members.length;
        document.getElementById('total-branches').textContent = this.branches.length;

        const branchesContainer = document.getElementById('branches-list');
        branchesContainer.innerHTML = '';

        this.branches.forEach(branch => {
            const memberCount = this.members.filter(m => m.branchId === branch.id).length;
            const branchCard = document.createElement('div');
            branchCard.className = 'branch-card';
            branchCard.innerHTML = `
                <h4>${branch.name}</h4>
                <div class="branch-info">📍 ${branch.address || 'No address provided'}</div>
                <div class="branch-info">👨‍💼 Pastor: ${branch.pastor || 'Not assigned'}</div>
                <span class="member-count">${memberCount} members</span>
            `;
            branchCard.addEventListener('click', () => {
                this.switchPage('members');
                document.getElementById('branch-filter').value = branch.id;
                this.renderMembers();
            });
            branchesContainer.appendChild(branchCard);
        });
    }    rend
erMembers() {
        const searchTerm = document.getElementById('member-search').value.toLowerCase();
        const branchFilter = document.getElementById('branch-filter').value;
        
        let filteredMembers = this.members;
        
        if (searchTerm) {
            filteredMembers = filteredMembers.filter(member => 
                member.name.toLowerCase().includes(searchTerm) ||
                member.occupation.toLowerCase().includes(searchTerm) ||
                member.department.toLowerCase().includes(searchTerm) ||
                member.phone.includes(searchTerm) ||
                member.email.toLowerCase().includes(searchTerm)
            );
        }
        
        if (branchFilter) {
            filteredMembers = filteredMembers.filter(member => 
                member.branchId === parseInt(branchFilter)
            );
        }

        const membersContainer = document.getElementById('members-list');
        membersContainer.innerHTML = '';

        if (filteredMembers.length === 0) {
            membersContainer.innerHTML = '<div style="text-align: center; padding: 2rem; color: #7f8c8d;">No members found</div>';
            return;
        }

        filteredMembers.forEach(member => {
            const branch = this.branches.find(b => b.id === member.branchId);
            const memberCard = document.createElement('div');
            memberCard.className = 'member-card';
            memberCard.innerHTML = `
                <div class="member-header">
                    <div class="member-name">${member.name}</div>
                    <div class="member-branch">${branch ? branch.name : 'Unknown Branch'}</div>
                </div>
                <div class="member-details">
                    ${member.phone ? `<div class="member-detail">📞 ${member.phone}</div>` : ''}
                    ${member.email ? `<div class="member-detail">✉️ ${member.email}</div>` : ''}
                    ${member.occupation ? `<div class="member-detail">💼 ${member.occupation}</div>` : ''}
                    ${member.workplace ? `<div class="member-detail">🏢 ${member.workplace}</div>` : ''}
                    ${member.address ? `<div class="member-detail">🏠 ${member.address}</div>` : ''}
                    ${member.joinDate ? `<div class="member-detail">📅 Joined: ${new Date(member.joinDate).toLocaleDateString()}</div>` : ''}
                </div>
                ${member.isWorker ? `<div class="worker-badge">⭐ ${member.department || 'Church Worker'}</div>` : ''}
                <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
                    <button class="btn-secondary" onclick="app.openMemberModal(${JSON.stringify(member).replace(/"/g, '&quot;')})">Edit</button>
                    <button class="btn-secondary" onclick="app.deleteMember(${member.id})" style="background: #e74c3c;">Delete</button>
                </div>
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
            const memberCount = this.members.filter(m => m.branchId === branch.id).length;
            const branchCard = document.createElement('div');
            branchCard.className = 'branch-card';
            branchCard.innerHTML = `
                <h4>${branch.name}</h4>
                <div class="branch-info">📍 ${branch.address || 'No address provided'}</div>
                <div class="branch-info">👨‍💼 Pastor: ${branch.pastor || 'Not assigned'}</div>
                <span class="member-count">${memberCount} members</span>
                <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
                    <button class="btn-secondary" onclick="app.openBranchModal(${JSON.stringify(branch).replace(/"/g, '&quot;')})">Edit</button>
                    <button class="btn-secondary" onclick="app.deleteBranch(${branch.id})" style="background: #e74c3c;">Delete</button>
                    <button class="btn-primary" onclick="app.viewBranchMembers(${branch.id})">View Members</button>
                </div>
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
            document.getElementById('member-branch'),
            document.getElementById('branch-filter')
        ];

        selects.forEach(select => {
            const currentValue = select.value;
            const isFilter = select.id === 'branch-filter';
            
            select.innerHTML = isFilter ? '<option value="">All Branches</option>' : '<option value="">Select Branch</option>';
            
            this.branches.forEach(branch => {
                const option = document.createElement('option');
                option.value = branch.id;
                option.textContent = branch.name;
                select.appendChild(option);
            });
            
            select.value = currentValue;
        });
    }

    saveToStorage() {
        localStorage.setItem('branches', JSON.stringify(this.branches));
        localStorage.setItem('members', JSON.stringify(this.members));
    }

    // Sample data for testing
    loadSampleData() {
        if (this.branches.length === 0 && this.members.length === 0) {
            // Add sample branches
            this.branches = [
                {
                    id: 1,
                    name: 'Main Branch - New York',
                    address: '123 Church Street, New York, NY 10001',
                    pastor: 'Pastor John Smith'
                },
                {
                    id: 2,
                    name: 'London Branch',
                    address: '45 Faith Avenue, London, UK',
                    pastor: 'Pastor Mary Johnson'
                },
                {
                    id: 3,
                    name: 'Lagos Branch',
                    address: '78 Hope Road, Lagos, Nigeria',
                    pastor: 'Pastor David Adebayo'
                }
            ];

            // Add sample members
            this.members = [
                {
                    id: 1,
                    name: 'Sarah Williams',
                    address: '456 Oak Street, New York, NY',
                    workplace: 'Microsoft Corporation',
                    occupation: 'Software Engineer',
                    joinDate: '2022-03-15',
                    branchId: 1,
                    isWorker: true,
                    department: 'Choir',
                    phone: '+1-555-0123',
                    email: 'sarah.williams@email.com'
                },
                {
                    id: 2,
                    name: 'Michael Brown',
                    address: '789 Pine Avenue, London',
                    workplace: 'BBC',
                    occupation: 'Journalist',
                    joinDate: '2021-08-20',
                    branchId: 2,
                    isWorker: false,
                    department: '',
                    phone: '+44-20-7946-0958',
                    email: 'michael.brown@email.com'
                },
                {
                    id: 3,
                    name: 'Grace Okafor',
                    address: '12 Victoria Island, Lagos',
                    workplace: 'First Bank Nigeria',
                    occupation: 'Bank Manager',
                    joinDate: '2020-12-10',
                    branchId: 3,
                    isWorker: true,
                    department: 'Ushering',
                    phone: '+234-803-123-4567',
                    email: 'grace.okafor@email.com'
                }
            ];

            this.saveToStorage();
            this.renderDashboard();
            this.renderMembers();
            this.renderBranches();
            this.updateBranchSelects();
        }
    }
}

// Initialize the app
const app = new ChurchManagementApp();

// Load sample data on first visit (for demo purposes)
// Remove this line in production
app.loadSampleData();