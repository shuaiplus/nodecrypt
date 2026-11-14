// Import necessary modules
// 导入必要的模块
import { deflate, inflate } from 'fflate';
import { showFileUploadModal } from './util.fileUpload.js';

// 分卷大小统一配置
const DEFAULT_VOLUME_SIZE = 256 * 1024; // 512KB

// File transfer state management
// 文件传输状态管理
window.fileTransfers = new Map();

// Base64 encoding for binary data (more efficient than hex)
// Base64编码用于二进制数据（比十六进制更高效）
function arrayBufferToBase64(buffer) {
	const uint8Array = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000; // 32KB chunks to avoid call stack limits
	
	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		const chunk = uint8Array.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk);
	}
	
	return btoa(binary);
}

// Base64 decoding back to binary
// Base64解码回二进制数据
function base64ToArrayBuffer(base64) {
	const binary = atob(base64);
	const uint8Array = new Uint8Array(binary.length);
	
	for (let i = 0; i < binary.length; i++) {
		uint8Array[i] = binary.charCodeAt(i);
	}
	
	return uint8Array;
}

// Generate unique file ID
// 生成唯一文件ID
function generateFileId() {
	return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Calculate SHA-256 hash for data integrity verification
// 计算SHA-256哈希值用于数据完整性验证
async function calculateHash(data) {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}



// Compress file into volumes with optimized compression
// 将文件压缩为分卷，优化压缩算法
async function compressFileToVolumes(file, volumeSize = DEFAULT_VOLUME_SIZE) { // 96KB原始数据，base64后约128KB
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = async function(e) {
			const arrayBuffer = new Uint8Array(e.target.result);
			
			try {
				// Calculate hash of original file for integrity
				const originalHash = await calculateHash(arrayBuffer);
				
				// Use single compression pass with balanced compression
				// 使用单次压缩，平衡压缩率和速度
				deflate(arrayBuffer, { 
					level: 6, // 平衡压缩级别
					mem: 8    // 合理内存使用
				}, (err, compressed) => {
					if (err) {
						reject(err);
						return;
					}
					
					// Split compressed data into volumes
					const volumes = [];
					for (let i = 0; i < compressed.length; i += volumeSize) {
						const volume = compressed.slice(i, i + volumeSize);
						volumes.push(arrayBufferToBase64(volume));
					}
					
					resolve({
						volumes,
						originalSize: file.size,
						compressedSize: compressed.length,
						originalHash
					});
				});
			} catch (hashError) {
				reject(hashError);
			}
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

// Compress multiple files into a single archive with volumes
// 将多个文件压缩为单个分卷归档
async function compressFilesToArchive(files, volumeSize = DEFAULT_VOLUME_SIZE) {	try {
		// Create a simple archive format: [file1_size][file1_name_length][file1_name][file1_data][file2_size]...
		// 创建简单的归档格式
		const archiveData = [];
		const fileManifest = [];
		
		for (const file of files) {
			const fileBuffer = await readFileAsArrayBuffer(file);
			const nameBytes = new TextEncoder().encode(file.name);
			
			// Add file metadata to manifest
			fileManifest.push({
				name: file.name,
				size: file.size,
				offset: 0 // Will be calculated later
			});
			
			// File format: [name_length(4)][name][size(8)][data]
			// Use separate arrays to avoid alignment issues
			const nameLengthBytes = new Uint8Array(4);
			const nameLengthView = new DataView(nameLengthBytes.buffer);
			nameLengthView.setUint32(0, nameBytes.length, true); // little endian
			
			const fileSizeBytes = new Uint8Array(8);
			const fileSizeView = new DataView(fileSizeBytes.buffer);
			fileSizeView.setBigUint64(0, BigInt(file.size), true); // little endian
			
			archiveData.push(
				nameLengthBytes,
				nameBytes,
				fileSizeBytes,
				new Uint8Array(fileBuffer)
			);
		}		
		// Combine all data
		const totalLength = archiveData.reduce((sum, part) => sum + part.length, 0);
		
		const combinedData = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const part of archiveData) {
			combinedData.set(part, offset);
			offset += part.length;
		}
		
		// Calculate hash of the entire archive
		const archiveHash = await calculateHash(combinedData);
		
		// Compress the archive
		return new Promise((resolve, reject) => {
			deflate(combinedData, { 
				level: 6,
				mem: 8
			}, (err, compressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Split compressed data into volumes
				const volumes = [];
				for (let i = 0; i < compressed.length; i += volumeSize) {
					const volume = compressed.slice(i, i + volumeSize);
					volumes.push(arrayBufferToBase64(volume));
				}
				
				resolve({
					volumes,
					originalSize: totalLength,
					compressedSize: compressed.length,
					archiveHash,
					fileCount: files.length,
					fileManifest
				});
			});
		});
	} catch (error) {
		throw new Error(`Archive compression failed: ${error.message}`);
	}
}

// Helper function to read file as array buffer
// 辅助函数：将文件读取为ArrayBuffer
function readFileAsArrayBuffer(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = (e) => resolve(e.target.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

// Decompress volumes back to file
// 将分卷解压回文件
async function decompressVolumesToFile(volumes, fileName, originalHash = null) {
	try {
		// Combine all volumes using base64 decoding
		const combinedData = volumes.map(volume => {
			return base64ToArrayBuffer(volume);
		});
		
		const totalLength = combinedData.reduce((sum, arr) => sum + arr.length, 0);
		const compressed = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const data of combinedData) {
			compressed.set(data, offset);
			offset += data.length;
		}
				// Decompress
		return new Promise((resolve, reject) => {
			inflate(compressed, async (err, decompressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Verify hash if provided
				if (originalHash) {
					try {
						const calculatedHash = await calculateHash(decompressed);
						if (calculatedHash !== originalHash) {
							reject(new Error('File integrity check failed: hash mismatch'));
							return;
						}
					} catch (hashError) {
						reject(new Error('File integrity check failed: ' + hashError.message));
						return;
					}
				}
				
				// Create blob and download
				const blob = new Blob([decompressed]);
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = fileName;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
				
				resolve();
			});
		});
	} catch (error) {
		console.error('Decompression error:', error);
		throw error;
	}
}

// Decompress archive volumes to multiple files
// 将归档分卷解压为多个文件
async function decompressArchiveToFiles(volumes, fileManifest, archiveHash = null) {
	try {
		// Combine all volumes using base64 decoding
		const combinedData = volumes.map(volume => {
			return base64ToArrayBuffer(volume);
		});
		
		const totalLength = combinedData.reduce((sum, arr) => sum + arr.length, 0);
		const compressed = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const data of combinedData) {
			compressed.set(data, offset);
			offset += data.length;
		}
		
		// Decompress archive
		return new Promise((resolve, reject) => {
			inflate(compressed, async (err, decompressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Verify archive hash if provided
				if (archiveHash) {
					try {
						const calculatedHash = await calculateHash(decompressed);
						if (calculatedHash !== archiveHash) {
							reject(new Error('Archive integrity check failed: hash mismatch'));
							return;
						}
					} catch (hashError) {
						reject(new Error('Archive integrity check failed: ' + hashError.message));
						return;
					}
				}
						// Extract files from archive
				let dataOffset = 0;
				const extractedFiles = [];
						for (const fileInfo of fileManifest) {
					// Read file metadata: [name_length(4)][name][size(8)][data]
					const nameLengthBytes = decompressed.slice(dataOffset, dataOffset + 4);
					const nameLengthView = new DataView(nameLengthBytes.buffer);
					const nameLength = nameLengthView.getUint32(0, true); // little endian
					dataOffset += 4;
					
					const nameBytes = decompressed.slice(dataOffset, dataOffset + nameLength);
					const fileName = new TextDecoder().decode(nameBytes);
					dataOffset += nameLength;
					
					// Use DataView to read BigUint64 safely
					const fileSizeBytes = decompressed.slice(dataOffset, dataOffset + 8);
					const fileSizeView = new DataView(fileSizeBytes.buffer);
					const fileSize = Number(fileSizeView.getBigUint64(0, true)); // little endian
					dataOffset += 8;
					
					const fileData = decompressed.slice(dataOffset, dataOffset + fileSize);
					dataOffset += fileSize;
					
					// Create and download file
					const blob = new Blob([fileData]);
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = fileName;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
					
					extractedFiles.push(fileName);
					
					// Add small delay between downloads to avoid overwhelming the browser
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				
				resolve(extractedFiles);
			});
		});
	} catch (error) {
		console.error('Archive decompression error:', error);
		throw error;
	}
}

// Setup file sending functionality
// 设置文件发送功能
export function setupFileSend({
	inputSelector,
	attachBtnSelector,
	fileInputSelector,
	onSend
}) {
	const attachBtn = document.querySelector(attachBtnSelector);
	
	if (attachBtn) {
		// 点击附件按钮显示文件上传模态框
		// Click attach button to show file upload modal
		attachBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			
			showFileUploadModal(async (files) => {
				// 传递 userName 给 onSend
				const userName = window.roomsData && window.activeRoomIndex >= 0
					? (window.roomsData[window.activeRoomIndex]?.myUserName || '')
					: '';
				await handleFilesUpload(files, (msg) => {
					// 合并 userName 字段
					onSend({ ...msg, userName });
				});
			});
		});
	}
}

// Handle files upload
// 处理文件上传
async function handleFilesUpload(files, onSend) {
	if (!files || files.length === 0) return;
	
	const fileId = generateFileId();
	
	try {
		// Show compression progress
		let progressElement = null;
		
		function showProgress(message) {
			// 删除系统提示
		}
		
		function updateProgress(message) {
			// 删除系统提示
		}
		
		if (files.length === 1) {
			// Single file upload
			const file = files[0];
			showProgress();
			
			const { volumes, originalSize, compressedSize, originalHash } = await compressFileToVolumes(file);
			
			updateProgress();
			
			// Create file transfer state
			const fileTransfer = {
				fileId,
				fileName: file.name,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				sentVolumes: 0,
				status: 'sending',
				originalHash
			};
			
			window.fileTransfers.set(fileId, fileTransfer);
			
			// Send file start message
			onSend({
				type: 'file_start',
				fileId,
				fileName: file.name,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				originalHash
			});
			
			// Send volumes
			await sendVolumes(fileId, volumes, onSend, updateProgress, file.name);
			
		} else {
			// Multiple files upload - create archive
			const totalSize = files.reduce((sum, file) => sum + file.size, 0);
			showProgress();
			
			const { volumes, originalSize, compressedSize, archiveHash, fileCount, fileManifest } = await compressFilesToArchive(files);
			
			updateProgress();
			
			// Create file transfer state for archive
			const fileTransfer = {
				fileId,
				fileName: `${files.length} files.zip`, // Virtual archive name
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				sentVolumes: 0,
				status: 'sending',
				archiveHash,
				fileCount,
				fileManifest,
				isArchive: true
			};
			
			window.fileTransfers.set(fileId, fileTransfer);
			
			// Send archive start message
			onSend({
				type: 'file_start',
				fileId,
				fileName: `${files.length} files`,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				archiveHash,
				fileCount,
				fileManifest,
				isArchive: true
			});
			
			// Send volumes
			await sendVolumes(fileId, volumes, onSend, updateProgress, `${files.length} files`);
		}
		
	} catch (error) {
		console.error('File compression error:', error);
		if (window.addSystemMsg) {
			window.addSystemMsg(`Failed to compress files: ${error.message}`);
		}
	}
}

// Send volumes with progress tracking
// 发送分卷并跟踪进度
async function sendVolumes(fileId, volumes, onSend, updateProgress, fileName) {
	const fileTransfer = window.fileTransfers.get(fileId);
	if (!fileTransfer) return;
	
	let currentVolume = 0;
	const batchSize = 5; // 每批发送5个分卷
	
	function sendNextBatch() {
		if (currentVolume >= volumes.length) {
			// 发送完成消息
			onSend({
				type: 'file_complete',
				fileId
			});
			
			fileTransfer.status = 'completed';
			updateFileProgress(fileId);
			updateProgress(`✓ Sent ${fileName} successfully`);
			return;
		}
		
		// 发送当前批次
		const batchEnd = Math.min(currentVolume + batchSize, volumes.length);
		const batch = [];
		
		for (let i = currentVolume; i < batchEnd; i++) {
			batch.push({
				type: 'file_volume',
				fileId,
				volumeIndex: i,
				volumeData: volumes[i],
				isLast: i === volumes.length - 1
			});
		}
		
		// 发送批次中的所有分卷
		batch.forEach(volumeMsg => onSend(volumeMsg));
		
		// 更新发送进度
		fileTransfer.sentVolumes = batchEnd;
		updateFileProgress(fileId);
		
		currentVolume = batchEnd;
		
		// 继续发送下一批，使用较短的延迟
		setTimeout(sendNextBatch, 100);
	}
	
	// 开始发送
	sendNextBatch();
}

// Update file progress in chat
// 更新聊天中的文件进度
function updateFileProgress(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer) return;
	const elements = document.querySelectorAll(`[data-file-id="${CSS.escape(fileId)}"]`);
	elements.forEach(element => {
		const progressContainer = element.querySelector('.file-progress-container');
		const progressBar = element.querySelector('.file-progress');
		const statusText = element.querySelector('.file-status');
		const downloadBtn = element.querySelector('.file-download-btn');
		
		// 判断是否为发送方（发送方没有volumeData）
		const isSender = !transfer.volumeData || transfer.volumeData.length === 0;
		
		if (transfer.status === 'sending') {
			const progress = (transfer.sentVolumes / transfer.totalVolumes) * 100;
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = `${progress}%`;
			if (statusText) statusText.textContent = `Sending ${transfer.sentVolumes}/${transfer.totalVolumes}`;
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
		} else if (transfer.status === 'receiving') {
			const progress = (transfer.receivedVolumes.size / transfer.totalVolumes) * 100;
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = `${progress}%`;
			if (statusText) statusText.textContent = `Receiving ${transfer.receivedVolumes.size}/${transfer.totalVolumes}`;
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
		} else if (transfer.status === 'completed') {
			// 传输完成时的动画序列
			if (progressContainer) {
				// 先添加淡出动画类
				progressContainer.classList.add('fade-out');
				// 延迟后完全隐藏
				setTimeout(() => {
					progressContainer.style.display = 'none';
				}, 400);
			}
			
			if (downloadBtn) {
				// 只有接收方才显示下载按钮
				if (isSender) {
					downloadBtn.classList.remove('show', 'animate-in');
					downloadBtn.style.display = 'none';
				} else {
					// 延迟显示下载按钮，等进度条消失动画完成
					setTimeout(() => {
						downloadBtn.style.display = 'flex';
						downloadBtn.classList.add('show');
						downloadBtn.disabled = false;
						// 添加进入动画
						setTimeout(() => {
							downloadBtn.classList.add('animate-in');
						}, 50);
						// 清理动画类
						setTimeout(() => {
							downloadBtn.classList.remove('animate-in');
						}, 550);
					}, 200);
				}
			}
		}
	});
}

// Handle incoming file messages
// 处理接收到的文件消息
export function handleFileMessage(message, isPrivate = false) {
	const { type, fileId, userName } = message;
	
	switch (type) {
		case 'file_start':
			handleFileStart(message, isPrivate);
			break;
		case 'file_volume':
			handleFileVolume(message);
			break;
		case 'file_complete':
			handleFileComplete(message);
			break;
	}
}

// Handle file start message
// 处理文件开始消息
function handleFileStart(message, isPrivate) {
	const { fileId, fileName, originalSize, compressedSize, totalVolumes, originalHash, archiveHash, fileCount, fileManifest, isArchive, userName } = message;
	
	const fileTransfer = {
		fileId,
		fileName,
		originalSize,
		compressedSize,
		totalVolumes,
		receivedVolumes: new Set(),
		volumeData: new Array(totalVolumes),
		status: 'receiving',
		originalHash,
		archiveHash,
		fileCount,
		fileManifest,
		isArchive,
		userName // 记录发送者名字
	};
	
	window.fileTransfers.set(fileId, fileTransfer);
	
	// 添加文件消息到聊天
	if (window.addOtherMsg) {
		let displayData;
		if (isArchive) {
			displayData = {
				type: 'file',
				fileId,
				fileName: `${fileCount} files`,
				originalSize,
				totalVolumes,
				fileCount,
				isArchive: true,
				userName
			};
		} else {
			displayData = {
				type: 'file',
				fileId,
				fileName,
				originalSize,
				totalVolumes,
				userName
			};
		}
		
		window.addOtherMsg(displayData, userName, userName, false, isPrivate ? 'file_private' : 'file');
	}
}

// Handle file volume message
// 处理文件分卷消息
function handleFileVolume(message) {
	const { fileId, volumeIndex, volumeData } = message;
	const transfer = window.fileTransfers.get(fileId);
	
	if (!transfer) return;
	
	transfer.receivedVolumes.add(volumeIndex);
	transfer.volumeData[volumeIndex] = volumeData;
	
	updateFileProgress(fileId);
}

// Handle file complete message
// 处理文件完成消息
function handleFileComplete(message) {
	const { fileId } = message;
	const transfer = window.fileTransfers.get(fileId);
	
	if (!transfer) return;
	
	// 检查是否所有分卷都已接收
	if (transfer.receivedVolumes.size === transfer.totalVolumes) {
		transfer.status = 'completed';
		updateFileProgress(fileId);
	}
}

// Download file from volumes
// 从分卷下载文件
export async function downloadFile(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || transfer.status !== 'completed') return;
	
	try {
		if (transfer.isArchive) {
			// Download archive as multiple files
			await decompressArchiveToFiles(transfer.volumeData, transfer.fileManifest, transfer.archiveHash);
			// 删除系统提示
		} else {
			// Download single file
			await decompressVolumesToFile(transfer.volumeData, transfer.fileName, transfer.originalHash);
			// 删除系统提示
		}
	} catch (error) {
		console.error('Download error:', error);
		window.addSystemMsg(`Failed to download: ${error.message}`);
	}
}

// Format file size
// 格式化文件大小
export function formatFileSize(bytes) {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Legacy image send function for backward compatibility
// 向后兼容的图片发送函数
export function setupImageSend(config) {
	setupFileSend(config);
}