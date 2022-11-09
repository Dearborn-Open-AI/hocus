import fsSync from "fs";
import fs from "fs/promises";
import { promisify } from "util";

import { v4 as uuidv4 } from "uuid";
import { Token } from "~/token";

import { createAgentInjector } from "./agent-injector";
import type { ProjectConfig } from "./project-config/validator";
import { execSshCmd } from "./utils";

export const createActivities = async () => {
  const injector = createAgentInjector();
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
     * Path to a drive with a Dockerfile.
     */
    inputDrivePath: string;
    outputDrive: {
      pathOnHost: string;
      maxSizeMiB: number;
      mountPath: string;
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
    const instanceId = `buildfs-${uuidv4()}`;
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
        await execSshCmd(
          { ssh, logFilePath: `/tmp/buildfs-${instanceId}.log`, opts: { cwd: workdir } },
          [
            buildfsScriptPath,
            `${inputDir}/project/${args.dockerfilePath}`,
            outputDir,
            `${inputDir}/project/${args.contextPath}`,
          ],
        );
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
    const instanceId = `checkout-and-inspect-${uuidv4()}`;
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
          const repoPath = `${workdir}/repo`;
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

  return {
    fetchRepository,
    buildfs,
    checkoutAndInspect,
  };
};

// /**
//  * Returns the pid of the firecracker process.
//  */
// export const startVM = async (args: {
//   instanceId: string;
//   kernelPath: string;
//   rootFsPath: string;
//   drives: Parameters<FirecrackerService["createVM"]>[0]["extraDrives"];
// }): Promise<void> => {
//   const logger = new DefaultLogger();
//   const socketPath = `/tmp/${args.instanceId}.sock`;
//   const fc = new FirecrackerService(socketPath);

//   await fc.startFirecrackerInstance(`/tmp/${args.instanceId}`);
//   logger.info("firecracker process started");

//   const vmIp = "168.254.0.21";
//   const tapDeviceIp = "168.254.0.22";
//   const tapDeviceCidr = 24;
//   const tapDeviceName = "hocus-tap-0";
//   fc.setupNetworking({
//     tapDeviceName,
//     tapDeviceIp,
//     tapDeviceCidr,
//   });
//   logger.info("networking set up");

//   await fc.createVM({
//     kernelPath: args.kernelPath,
//     rootFsPath: args.rootFsPath,
//     vmIp,
//     tapDeviceIp,
//     tapDeviceName,
//     tapDeviceCidr,
//     extraDrives: args.drives,
//   });
//   logger.info("vm created");
// };
