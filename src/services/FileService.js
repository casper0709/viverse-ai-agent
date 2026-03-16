import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';

class FileService {
    constructor() {
        // Base directory for allowed file operations (portable for cloud deployment)
        this.baseDir = process.env.VIVERSE_PROJECTS_DIR || process.cwd();
    }

    /**
     * Resolve and validate path is strictly within the allowed parameter
     */
    resolvePath(targetPath, allowedDir = this.baseDir) {
        let absolutePath;
        if (path.isAbsolute(targetPath)) {
            absolutePath = targetPath;
        } else {
            absolutePath = path.resolve(allowedDir, targetPath);
        }

        if (!absolutePath.startsWith(allowedDir)) {
            throw new Error(`CRITICAL SECURITY ALERT: Path ${targetPath} is strictly forbidden outside of sandbox ${allowedDir}`);
        }
        return absolutePath;
    }

    async readFile(filePath, workspacePath) {
        try {
            const resolvedPath = this.resolvePath(filePath, workspacePath || this.baseDir);
            const content = await fs.readFile(resolvedPath, 'utf8');
            return content;
        } catch (error) {
            logger.error(`FileService.readFile Error: ${error.message}`);
            throw error;
        }
    }

    async listFiles(dirPath = '.', workspacePath) {
        try {
            const resolvedPath = this.resolvePath(dirPath, workspacePath || this.baseDir);
            const files = await fs.readdir(resolvedPath, { withFileTypes: true });
            return files.map(f => ({
                name: f.name,
                isDirectory: f.isDirectory(),
                path: path.join(dirPath, f.name)
            }));
        } catch (error) {
            logger.error(`FileService.listFiles Error: ${error.message}`);
            throw error;
        }
    }

    async writeFile(filePath, content, workspacePath) {
        try {
            const resolvedPath = this.resolvePath(filePath, workspacePath || this.baseDir);
            await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
            await fs.writeFile(resolvedPath, content, 'utf8');
            return { success: true, path: filePath };
        } catch (error) {
            logger.error(`FileService.writeFile Error: ${error.message}`);
            throw error;
        }
    }

    async runCommand(command, cwd, workspacePath) {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        try {
            const activeDir = workspacePath || this.baseDir;
            const workingDir = cwd ? this.resolvePath(cwd, activeDir) : activeDir;
            logger.info(`Running command: ${command} in ${workingDir}`);
            
            // Added 2 minute timeout to prevent orphan hanging processes
            const { stdout, stderr } = await execAsync(command, { 
                cwd: workingDir,
                timeout: 120000 
            });

            if (!stdout && !stderr) {
                return { result: "Command executed successfully but produced no output." };
            }

            return { stdout: stdout || "", stderr: stderr || "" };
        } catch (error) {
            logger.error(`FileService.runCommand Error: ${error.message}`);
            // Log full error details for debugging
            if (error.stdout) logger.info(`Final STDOUT: ${error.stdout}`);
            if (error.stderr) logger.info(`Final STDERR: ${error.stderr}`);
            
            return {
                error: error.message,
                stdout: error.stdout || "",
                stderr: error.stderr || ""
            };
        }
    }

    async runBackgroundCommand(command, cwd, workspacePath) {
        const { spawn } = await import('child_process');
        const activeDir = workspacePath || this.baseDir;
        const workingDir = cwd ? this.resolvePath(cwd, activeDir) : activeDir;
        
        // Generate a simple Job ID based on timestamp
        const jobId = `job_${Date.now()}`;
        const logFilePath = path.join(workingDir, `${jobId}.log`);
        
        logger.info(`Starting background command [${jobId}]: ${command} in ${workingDir}`);

        try {
            // Split command and arguments safely (very basic split for demo)
            const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g).map(p => p.replace(/(^"|"$)/g, ''));
            const cmd = parts[0];
            const args = parts.slice(1);

            const child = spawn(cmd, args, { cwd: workingDir, shell: true });

            // Store process info in memory (in a production app, use Redis or similar)
            if (!this.activeJobs) this.activeJobs = new Map();
            this.activeJobs.set(jobId, { status: "running", exitCode: null, logFile: logFilePath });

            // Write output to log file
            const fsModule = await import('fs');
            const logStream = fsModule.createWriteStream(logFilePath, { flags: 'a' });

            child.stdout.pipe(logStream);
            child.stderr.pipe(logStream);

            child.on('close', (code) => {
                logger.info(`Background command [${jobId}] exited with code ${code}`);
                const job = this.activeJobs.get(jobId);
                if (job) {
                    job.status = code === 0 ? "completed" : "failed";
                    job.exitCode = code;
                }
                logStream.end();
            });

            return { 
                jobId: jobId, 
                status: "Started in background", 
                logFile: `${jobId}.log`,
                message: "Use checkCommandStatus with this jobId to see progress."
            };
        } catch (error) {
            logger.error(`FileService.runBackgroundCommand Error: ${error.message}`);
            throw error;
        }
    }

    async checkCommandStatus(jobId, cwd, workspacePath) {
        if (!this.activeJobs || !this.activeJobs.has(jobId)) {
            return { error: `Job ID ${jobId} not found.` };
        }

        const job = this.activeJobs.get(jobId);
        const activeDir = workspacePath || this.baseDir;
        const workingDir = cwd ? this.resolvePath(cwd, activeDir) : activeDir;
        const logPath = path.isAbsolute(job.logFile) ? job.logFile : path.join(workingDir, job.logFile);

        try {
            // Read the last 2000 characters of the log to prevent token overflow
            const fsModule = await import('fs/promises');
            const stats = await fsModule.stat(logPath);
            const size = stats.size;
            
            let logContent = "";
            if (size > 0) {
                const readSize = Math.min(size, 2000);
                const buffer = Buffer.alloc(readSize);
                const fileHandle = await fsModule.open(logPath, 'r');
                await fileHandle.read(buffer, 0, readSize, size - readSize);
                await fileHandle.close();
                logContent = buffer.toString('utf8');
            }

            return {
                jobId: jobId,
                status: job.status,
                exitCode: job.exitCode,
                recentLog: logContent || "No output yet."
            };
        } catch (error) {
            logger.error(`Error checking job status: ${error.message}`);
            return { status: job.status, error: "Could not read log file." };
        }
    }

    async addLesson(lesson, workspacePath) {
        try {
            const lessonsPath = this.resolvePath('.viverse_lessons.json', workspacePath || this.baseDir);
            let lessons = [];
            try {
                const fsModule = await import('fs/promises');
                const content = await fsModule.readFile(lessonsPath, 'utf8');
                lessons = JSON.parse(content);
            } catch (e) {
                // File might not exist yet, that's fine
            }
            
            if (!lessons.includes(lesson)) {
                lessons.push(lesson);
                const fsModule = await import('fs/promises');
                await fsModule.writeFile(lessonsPath, JSON.stringify(lessons, null, 2), 'utf8');
                logger.info(`FileService: Captured new lesson in ${lessonsPath}`);
            }
            return { success: true, lessonCount: lessons.length };
        } catch (error) {
            logger.error(`FileService.addLesson Error: ${error.message}`);
            throw error;
        }
    }
}

export default new FileService();
