import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

import type { VmTask, Prisma } from "@prisma/client";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { VmTaskStatus } from "@prisma/client";
import type { NodeSSH } from "node-ssh";
import { v4 as uuidv4 } from "uuid";
import { GroupError } from "~/group-error";
import { Token } from "~/token";
import { waitForPromises } from "~/utils.shared";

import type { createAgentInjector } from "./agent-injector";
import { PidValidator } from "./pid.validator";
import type { ProjectConfig } from "./project-config/validator";
import { execSshCmd, randomString, sleep, withSsh } from "./utils";

export const createActivities = async (
  injector: ReturnType<typeof createAgentInjector>,
  db: Prisma.NonTransactionClient,
) => {
  const agentConfig = injector.resolve(Token.Config).agent();

  const fetchRepository = async (args: {
    /**
     * Every project should have a separate root fs,
     * because repository credentials are stored in the root fs.
     */
    rootFsPath: string;
    outputDrive: {
      pathOnHost: string;
      maxSizeMiB: number;
    };
    repository: {
      url: string;
      credentials?: {
        /**
         * The contents of the private SSH key, e.g.:
         * ```
         * -----BEGIN OPENSSH PRIVATE KEY-----
         * b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
         * ...
         * -----END OPENSSH PRIVATE KEY-----
         * ```
         * Keep in mind that a newline at the end of the key is required.
         */
        privateSshKey: string;
      };
    };
  }): Promise<void> => {
    const instanceId = `fetchrepo-${uuidv4()}`;
    const logger = injector.resolve(Token.Logger);
    const firecrackerService = injector.resolve(Token.FirecrackerService)(instanceId);
    const agentUtilService = injector.resolve(Token.AgentUtilService);
    const outputDriveExists = fsSync.existsSync(args.outputDrive.pathOnHost);
    if (!outputDriveExists) {
      agentUtilService.createExt4Image(args.outputDrive.pathOnHost, args.outputDrive.maxSizeMiB);
      logger.info(`empty output image created at ${args.outputDrive.pathOnHost}`);
    }
    const outputDir = "/tmp/output";
    await firecrackerService.withVM(
      {
        ssh: {
          username: "hocus",
          password: "hocus",
        },
        kernelPath: agentConfig.defaultKernel,
        rootFsPath: args.rootFsPath,
        extraDrives: [
          {
            pathOnHost: args.outputDrive.pathOnHost,
            guestMountPath: outputDir,
          },
        ],
      },
      async ({ ssh }) => {
        const repositoryDir = `${outputDir}/project`;
        const logFilePath = "/tmp/ssh-fetchrepo.log";
        if (!outputDriveExists) {
          await execSshCmd({ ssh }, ["sudo", "chown", "-R", "hocus:hocus", outputDir]);
        }

        const sshKey = args.repository.credentials?.privateSshKey;
        const sshDir = "/home/hocus/.ssh";
        if (sshKey != null) {
          // The name is misleading, since the user may not be
          // using RSA, but git automatically looks for this file and
          // it will work no matter the actual ssh key format.
          const sshKeyPath = `${sshDir}/id_rsa`;
          await execSshCmd({ ssh }, ["mkdir", "-p", sshDir]);
          await execSshCmd({ ssh }, ["sudo", "mount", "-t", "tmpfs", "ssh", sshDir]);
          await execSshCmd({ ssh }, ["sudo", "chown", "hocus:hocus", sshDir]);
          await execSshCmd({ ssh }, ["chmod", "700", sshDir]);
          await ssh.withSFTP(async (sftp) => {
            const writeFile = promisify(sftp.writeFile.bind(sftp));
            await writeFile(sshKeyPath, sshKey);
          });
          await execSshCmd({ ssh }, ["chmod", "400", sshKeyPath]);
        }

        const repositoryExists =
          (
            await execSshCmd({ ssh, allowNonZeroExitCode: true }, [
              "test",
              "-d",
              `${repositoryDir}/.git`,
            ])
          ).code === 0;
        if (repositoryExists) {
          await execSshCmd({ ssh, logFilePath, opts: { cwd: repositoryDir } }, [
            "git",
            "fetch",
            "--all",
          ]);
        } else {
          await execSshCmd(
            {
              ssh,
              logFilePath,
              opts: {
                execOptions: {
                  env: {
                    // Without this, git will ask for user input and the command will fail.
                    // This is obviously not secure, the correct method would be to
                    // TODO: allow the user to specify a known_hosts file.
                    GIT_SSH_COMMAND:
                      "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no",
                  } as any,
                },
              },
            },
            ["git", "clone", "--no-checkout", args.repository.url, repositoryDir],
          );
        }
      },
    );
  };

  const buildfs = async (args: {
    /**
     * Used to construct file paths. Autogenerated if not specified.
     * Useful mostly for debugging.
     */
    runId?: string;
    /**
     * Path to a drive with a Dockerfile.
     */
    inputDrivePath: string;
    outputDrive: {
      pathOnHost: string;
      maxSizeMiB: number;
    };
    /**
     * The relative path to the Dockerfile in the `project` directory of the input drive.
     */
    dockerfilePath: string;
    /**
     * The relative path to the build context in the `project` directory of the input drive.
     */
    contextPath: string;
  }): Promise<void> => {
    const runId = args.runId ?? uuidv4();
    const instanceId = `buildfs-${runId}`;
    const firecrackerService = injector.resolve(Token.FirecrackerService)(instanceId);
    const agentUtilService = injector.resolve(Token.AgentUtilService);

    agentUtilService.createExt4Image(
      args.outputDrive.pathOnHost,
      args.outputDrive.maxSizeMiB,
      true,
    );

    const inputDir = "/tmp/input";
    const outputDir = "/tmp/output";
    await firecrackerService.withVM(
      {
        ssh: {
          username: "root",
          password: "root",
        },
        kernelPath: agentConfig.defaultKernel,
        rootFsPath: agentConfig.buildfsRootFs,
        extraDrives: [
          { pathOnHost: args.outputDrive.pathOnHost, guestMountPath: outputDir },
          { pathOnHost: args.inputDrivePath, guestMountPath: inputDir },
        ],
      },
      async ({ ssh }) => {
        const workdir = "/tmp/workdir";
        const buildfsScriptPath = `${workdir}/bin/buildfs.sh`;
        await execSshCmd({ ssh }, ["rm", "-rf", workdir]);
        await execSshCmd({ ssh }, ["mkdir", "-p", workdir]);
        await ssh.putDirectory(agentConfig.hostBuildfsResourcesDir, workdir);
        await execSshCmd({ ssh }, ["chmod", "+x", buildfsScriptPath]);
        await execSshCmd({ ssh, logFilePath: `/tmp/buildfs-${runId}-ssh.log` }, [
          buildfsScriptPath,
          path.join(inputDir, "project", args.dockerfilePath),
          outputDir,
          path.join(inputDir, "project", args.contextPath),
        ]);
      },
    );
  };

  /**
   * Copies the contents of `repositoryDrivePath` into `outputDrivePath`, and checks
   * out the given branch there.
   *
   * Returns `ProjectConfig` if a hocus config file is present in the repository.
   * Otherwise, returns `null`.
   */
  const checkoutAndInspect = async (args: {
    /**
     * Should point to the output of `fetchRepository`
     */
    repositoryDrivePath: string;
    /**
     * The repository will be checked out to this branch.
     */
    targetBranch: string;
    /**
     * A new drive will be created at this path.
     */
    outputDrivePath: string;
  }): Promise<ProjectConfig | null> => {
    const instanceId = `checkout-and-inspect-${randomString(8)}`;
    const firecrackerService = injector.resolve(Token.FirecrackerService)(instanceId);
    const logger = injector.resolve(Token.Logger);
    const projectConfigService = injector.resolve(Token.ProjectConfigService);
    if (fsSync.existsSync(args.outputDrivePath)) {
      logger.warn(
        `output drive already exists at "${args.outputDrivePath}", it will be overwritten`,
      );
    }
    await fs.copyFile(args.repositoryDrivePath, args.outputDrivePath);
    const workdir = "/tmp/workdir";
    try {
      return await firecrackerService.withVM(
        {
          ssh: {
            username: "hocus",
            password: "hocus",
          },
          kernelPath: agentConfig.defaultKernel,
          rootFsPath: agentConfig.checkoutAndInspectRootFs,
          extraDrives: [{ pathOnHost: args.outputDrivePath, guestMountPath: workdir }],
        },
        async ({ ssh }) => {
          const repoPath = `${workdir}/project`;
          await execSshCmd({ ssh, opts: { cwd: repoPath } }, [
            "git",
            "checkout",
            args.targetBranch,
          ]);
          return await projectConfigService.getConfig(ssh, repoPath);
        },
      );
    } catch (err) {
      await fs.unlink(args.outputDrivePath);
      throw err;
    }
  };

  type PrebuildTaskOutput =
    | {
        status: typeof VmTaskStatus["VM_TASK_STATUS_SUCCESS"];
      }
    | {
        status: typeof VmTaskStatus["VM_TASK_STATUS_ERROR"];
        error: Error;
      }
    | {
        status: typeof VmTaskStatus["VM_TASK_STATUS_CANCELLED"];
      };

  /**
   * Returns the result for every task.
   *
   * Assumes that there is a `hocus` user with passwordless sudo on the
   * filesystem drive, sshd is configured to start running automatically after VM boot,
   * and the corresponding public key to the private key used to connect to the VM
   * (`agentConfig.prebuildSshPrivateKey`) is already present in the `hocus` user's authorized_keys.
   */
  const prebuild = async (args: {
    runId?: string;
    projectDrivePath: string;
    filesystemDrivePath: string;
    prebuildEventId: bigint;
  }): Promise<PrebuildTaskOutput[]> => {
    const runId = args.runId ?? uuidv4();
    const instanceId = `prebuild-${runId}`;
    const firecrackerService = injector.resolve(Token.FirecrackerService)(instanceId);
    const agentUtilService = injector.resolve(Token.AgentUtilService);
    const devDir = "/home/hocus/dev";
    const repositoryDir = `${devDir}/project`;
    const prebuildScriptsDir = `${devDir}/.hocus/init`;

    const prebuildEvent = await db.prebuildEvent.findUniqueOrThrow({
      where: { id: args.prebuildEventId },
      include: { prebuildTasks: true },
    });
    const tasks = prebuildEvent.prebuildTasks;
    return await firecrackerService.withVM(
      {
        ssh: {
          username: "hocus",
          privateKey: agentConfig.prebuildSshPrivateKey,
        },
        kernelPath: agentConfig.defaultKernel,
        rootFsPath: args.filesystemDrivePath,
        extraDrives: [{ pathOnHost: args.projectDrivePath, guestMountPath: devDir }],
      },
      async ({ ssh, sshConfig }) => {
        let cleanupStarted = false;

        const taskSshHandles: NodeSSH[] = [];
        const taskFn = async (task: VmTask) => {
          const script = agentUtilService.generatePrebuildScript(task.command);
          const scriptPath = `${prebuildScriptsDir}/task-${task.idx}.sh`;
          const logPath = `${prebuildScriptsDir}/task-${task.idx}.log`;
          await execSshCmd({ ssh }, ["mkdir", "-p", prebuildScriptsDir]);
          await agentUtilService.writeFile(ssh, scriptPath, script);

          await withSsh(sshConfig, async (taskSsh) => {
            if (cleanupStarted) {
              throw new Error("cleanup already started");
            }
            taskSshHandles.push(taskSsh);

            let finished = false;
            let syncCounter = 0;
            let logBuffer: Buffer[] = [];
            const syncLogs = async () => {
              let lastSync = 0;
              while (!finished) {
                await sleep(Math.max(0, lastSync + 1000 - Date.now()));
                lastSync = Date.now();
                if (cleanupStarted) {
                  throw new Error("cleanup started");
                }
                if (logBuffer.length === 0) {
                  continue;
                }
                const currentSyncIdx = syncCounter;
                syncCounter += 1;

                const content = Buffer.concat(logBuffer);
                logBuffer = [];
                await db.log.create({
                  data: {
                    idx: currentSyncIdx,
                    logGroupId: task.logGroupId,
                    content,
                  },
                });
              }
            };

            await waitForPromises([
              execSshCmd(
                {
                  ssh: taskSsh,
                  opts: {
                    cwd: repositoryDir,
                    onStdout: (chunk) => logBuffer.push(chunk),
                    onStderr: (chunk) => logBuffer.push(chunk),
                  },
                },
                [
                  "bash",
                  "-o",
                  "pipefail",
                  "-o",
                  "errexit",
                  "-c",
                  `bash "${scriptPath}" 2>&1 | tee "${logPath}"`,
                ],
              ).finally(() => (finished = true)),
              syncLogs().catch((err) => {
                taskSsh.dispose();
                throw err;
              }),
            ]);
          });
        };
        const taskFinished = tasks.map((_) => false);
        const taskCancelled = tasks.map((_) => false);
        const taskPromises = tasks.map(async (task, taskIdx) => {
          const updateStatus = (status: VmTaskStatus) =>
            db.vmTask.update({
              where: { id: task.id },
              data: { status },
            });

          try {
            try {
              await updateStatus(VmTaskStatus.VM_TASK_STATUS_RUNNING);
              await taskFn(task);
              await updateStatus(VmTaskStatus.VM_TASK_STATUS_SUCCESS);
            } finally {
              taskFinished[taskIdx] = true;
            }
          } catch (err) {
            if (!cleanupStarted) {
              cleanupStarted = true;
              for (const [idx, isFinished] of taskFinished.entries()) {
                taskCancelled[idx] = !isFinished;
              }
              // this is done to interrupt the other tasks, withSsh will dispose the
              // ssh handles anyway
              await Promise.all(taskSshHandles.map((sshHandle) => sshHandle.dispose()));
            }

            try {
              await updateStatus(
                taskCancelled[taskIdx]
                  ? VmTaskStatus.VM_TASK_STATUS_CANCELLED
                  : VmTaskStatus.VM_TASK_STATUS_ERROR,
              );
            } catch (updateErr) {
              throw new GroupError([err, updateErr]);
            }

            throw err;
          }
        });
        const results = await Promise.allSettled(taskPromises);
        const parsedResults = results.map((result, idx) => {
          if (result.status === "rejected") {
            if (taskCancelled[idx]) {
              return {
                status: VmTaskStatus.VM_TASK_STATUS_CANCELLED,
              };
            }
            return {
              status: VmTaskStatus.VM_TASK_STATUS_ERROR,
              error:
                result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
            };
          } else {
            return { status: VmTaskStatus.VM_TASK_STATUS_SUCCESS };
          }
        });
        return parsedResults;
      },
    );
  };

  type StartWorkspaceReturnValue = {
    firecrackerProcessPid: number;
    vmIp: string;
    vmInstanceId: string;
    ipBlockId: number;
    taskPids: number[];
  };

  const startWorkspace = async (args: {
    runId?: string;
    filesystemDrivePath: string;
    projectDrivePath: string;
    authorizedKeys: string[];
    tasks: string[];
  }): Promise<StartWorkspaceReturnValue> => {
    const runId = args.runId ?? uuidv4();
    const instanceId = `startvm-${runId}`;
    const firecrackerService = injector.resolve(Token.FirecrackerService)(instanceId);
    const agentUtilService = injector.resolve(Token.AgentUtilService);
    const sshGatewayService = injector.resolve(Token.SSHGatewayService);
    const devDir = "/home/hocus/dev";
    const repositoryDir = `${devDir}/project`;
    const scriptsDir = `${devDir}/.hocus/command`;

    return await firecrackerService.withVM(
      {
        ssh: {
          username: "hocus",
          privateKey: agentConfig.prebuildSshPrivateKey,
        },
        kernelPath: agentConfig.defaultKernel,
        rootFsPath: args.filesystemDrivePath,
        extraDrives: [{ pathOnHost: args.projectDrivePath, guestMountPath: devDir }],
        shouldPoweroff: false,
      },
      async ({ ssh, vmIp, firecrackerPid, ipBlockId }) => {
        const taskFn = async (task: string, taskIdx: number): Promise<number> => {
          const script = agentUtilService.generatePrebuildScript(task);
          const scriptPath = `${scriptsDir}/task-${taskIdx}.sh`;
          const logPath = `${scriptsDir}/task-${taskIdx}.log`;
          await execSshCmd({ ssh }, ["mkdir", "-p", scriptsDir]);
          await agentUtilService.writeFile(ssh, scriptPath, script);

          const result = await execSshCmd({ ssh, opts: { cwd: repositoryDir } }, [
            "bash",
            "-o",
            "pipefail",
            "-o",
            "errexit",
            "-c",
            `bash "${scriptPath}" > "${logPath}" 2>&1 & echo "$!"`,
          ]);
          return Number(PidValidator.Parse(result.stdout));
        };
        const authorizedKeys = args.authorizedKeys.map((key) => key.trim());
        await agentUtilService.writeFile(
          ssh,
          "/home/hocus/.ssh/authorized_keys",
          authorizedKeys.join("\n") + "\n",
        );
        const taskPids = await Promise.all(args.tasks.map(taskFn));
        await firecrackerService.changeVMNetworkVisibility(ipBlockId, "public");
        await sshGatewayService.addPublicKeysToAuthorizedKeys(authorizedKeys);
        return {
          firecrackerProcessPid: firecrackerPid,
          vmIp,
          taskPids,
          ipBlockId,
          vmInstanceId: instanceId,
        };
      },
    );
  };

  const stopWorkspace = async (args: { instanceId: string; ipBlockId: number }): Promise<void> => {
    const firecrackerService = injector.resolve(Token.FirecrackerService)(args.instanceId);
    await firecrackerService.shutdownVMAndReleaseResources(args.ipBlockId);
  };

  return {
    fetchRepository,
    buildfs,
    checkoutAndInspect,
    prebuild,
    startWorkspace,
    stopWorkspace,
  };
};
