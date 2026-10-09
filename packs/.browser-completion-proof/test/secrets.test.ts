/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell reads the server's keys. A code worker is a thread of the server's process, and `process.report.getReport().environmentVariables` shows the process's whole environment
 * block however the worker's own `process.env` was scrubbed (measured on the built bundle). The keys the pack needs are taken out of the block at start and handed only to the process that needs them; the real server,
 * with a real cell reading the report and a child process's environment, is proven in code-bundle.test.ts. This holds the decisions on environments of the test's own, so the test process's is never touched.
 */
import { describe, expect, test } from "bun:test";
import { LaunchSecrets } from "../src/secrets";

describe("the secrets the pack is started with", () => {
  test("the jev keys leave the environment and are still handed to the process that needs them, and to nothing else", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", TYPESAFE_API_KEY: "sk-a", TEXT_MODEL_API_KEY: "sk-b", DIM_BROWSER_PYTHON: "python" };
    const secrets = new LaunchSecrets();
    secrets.take(env);
    expect(env).toEqual({ PATH: "/bin", DIM_BROWSER_PYTHON: "python" });
    expect(secrets.get("TYPESAFE_API_KEY", env)).toBe("sk-a");
    expect(secrets.environment(env)).toEqual({ PATH: "/bin", DIM_BROWSER_PYTHON: "python", TYPESAFE_API_KEY: "sk-a", TEXT_MODEL_API_KEY: "sk-b" });
    // The environment itself, read again, is still clean: handing the keys over does not put them back.
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
  });

  test("another secret of the host's in a DIMENSION_ variable is deleted, and the pack's own DIMENSION_BROWSER_ settings are not, whatever they are called", () => {
    const env: NodeJS.ProcessEnv = {
      DIMENSION_FAKE_SECRET: "s1",
      DIMENSION_API_TOKEN: "s2",
      DIMENSION_SOME_PASSWORD: "s3",
      dimension_lower_key: "s4",
      DIMENSION_BROWSER_ROOT: "C:/root",
      DIMENSION_BROWSER_ALLOW_PASSWORD_FIELDS: "true",
      DIMENSION_BROWSER_MODEL_TOOLS: "code",
      DIMENSION_HOME: "C:/home",
    };
    new LaunchSecrets().take(env);
    expect(env).toEqual({ DIMENSION_BROWSER_ROOT: "C:/root", DIMENSION_BROWSER_ALLOW_PASSWORD_FIELDS: "true", DIMENSION_BROWSER_MODEL_TOOLS: "code", DIMENSION_HOME: "C:/home" });
  });

  test("the key is found under any spelling of its name, because Windows has one environment variable for them all", () => {
    const env: NodeJS.ProcessEnv = { Typesafe_Api_Key: "sk-a" };
    const secrets = new LaunchSecrets();
    secrets.take(env);
    expect(env).toEqual({});
    expect(secrets.get("TYPESAFE_API_KEY", env)).toBe("sk-a");
  });

  test("taking twice keeps what the first took (a second server start in one process, or a restart of the reader)", () => {
    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "sk-a" };
    const secrets = new LaunchSecrets();
    secrets.take(env);
    secrets.take(env);
    expect(secrets.get("TYPESAFE_API_KEY", env)).toBe("sk-a");
  });

  test("a server that never took (a test's, an embedder's) reads the environment as it is, so a key set later counts", () => {
    const secrets = new LaunchSecrets();
    const env: NodeJS.ProcessEnv = {};
    expect(secrets.get("TYPESAFE_API_KEY", env)).toBeUndefined();
    env.TYPESAFE_API_KEY = "sk-late";
    expect(secrets.get("TYPESAFE_API_KEY", env)).toBe("sk-late");
    expect(secrets.environment(env).TYPESAFE_API_KEY).toBe("sk-late");
  });
});
