/*
 * SPIKE ONLY — NOT the proposed implementation.
 *
 * This is the *alternative* the specification hoped to avoid: the compiled
 * helper Codex ships as `codex-linux-sandbox`. It exists here for one reason —
 * to put a real number on what the bun:ffi approach costs relative to it, so
 * that README.md can state the trade instead of guessing at it.
 *
 * Deliberately the same ruleset and the same argument shape as landlock-exec.ts.
 *
 *   cc -O2 -o alternative-helper alternative-helper.c
 *   ./alternative-helper [--ro PATH]... [--rw PATH]... -- <command> [args...]
 */

#define _GNU_SOURCE /* O_PATH */

#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#define APPLY_FAILED_EXIT_CODE 125

static long ll_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size,
                              __u32 flags) {
  return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static long ll_add_rule(int fd, enum landlock_rule_type type, const void *attr,
                        __u32 flags) {
  return syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}

static long ll_restrict_self(int fd, __u32 flags) {
  return syscall(__NR_landlock_restrict_self, fd, flags);
}

/* Mirrors READ_ONLY_ACCESS / READ_WRITE_ACCESS in landlock-ffi.ts. */
#define RO_ACCESS                                                              \
  (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |                 \
   LANDLOCK_ACCESS_FS_READ_DIR)

#define RW_ACCESS                                                              \
  (RO_ACCESS | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | \
   LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |             \
   LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |                 \
   LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |               \
   LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |               \
   LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE)

/* Mirrors DEVICE_ACCESS in landlock-ffi.ts. Must exist here too: bench.sh
   hands the SAME argv to both implementations, so a flag this helper does not
   understand makes it exit 125 at parse time — and a benchmark that times a
   process which never applied a ruleset or ran a command reports a number for
   work that did not happen. That is exactly how the first published
   compiled-helper figure came to be fabricated. */
#define DEV_ACCESS                                                             \
  (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE |              \
   LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |                 \
   LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE)

static int add_path(int ruleset_fd, const char *path, __u64 allowed) {
  struct landlock_path_beneath_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.allowed_access = allowed;
  attr.parent_fd = open(path, O_PATH | O_CLOEXEC);
  if (attr.parent_fd < 0) {
    fprintf(stderr, "alternative-helper: open(%s): %s\n", path, strerror(errno));
    return -1;
  }
  if (ll_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0) != 0) {
    fprintf(stderr, "alternative-helper: add_rule(%s): %s\n", path, strerror(errno));
    close(attr.parent_fd);
    return -1;
  }
  close(attr.parent_fd);
  return 0;
}

int main(int argc, char **argv) {
  int abi = (int)ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) {
    fprintf(stderr, "alternative-helper: landlock unavailable (abi %d)\n", abi);
    return APPLY_FAILED_EXIT_CODE;
  }

  struct landlock_ruleset_attr ruleset_attr;
  memset(&ruleset_attr, 0, sizeof(ruleset_attr));
  /* Clamp to ABI 3's FS bits, matching fsMaskForAbi() for ABI 3 and 4. */
  ruleset_attr.handled_access_fs = ((__u64)1 << 15) - 1;

  /* sizeof(__u64), not sizeof(ruleset_attr): this helper handles the FS axis
     only, and the 8-byte form is the pre-ABI-4 struct that omits
     handled_access_net. landlock-exec.ts sends the 16-byte form on ABI 4 with
     handled_access_net = 0, which is equivalent for the FS axis; the extra 8
     bytes are not what the benchmark is measuring. */
  int ruleset_fd = (int)ll_create_ruleset(&ruleset_attr, sizeof(__u64), 0);
  if (ruleset_fd < 0) {
    fprintf(stderr, "alternative-helper: create_ruleset: %s\n", strerror(errno));
    return APPLY_FAILED_EXIT_CODE;
  }

  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    }
    if (i + 1 >= argc) {
      fprintf(stderr, "alternative-helper: %s needs a value\n", argv[i]);
      return APPLY_FAILED_EXIT_CODE;
    }
    __u64 access;
    if (strcmp(argv[i], "--ro") == 0) {
      access = RO_ACCESS;
    } else if (strcmp(argv[i], "--rw") == 0) {
      access = RW_ACCESS;
    } else if (strcmp(argv[i], "--dev") == 0) {
      access = DEV_ACCESS;
    } else {
      fprintf(stderr, "alternative-helper: unknown flag %s\n", argv[i]);
      return APPLY_FAILED_EXIT_CODE;
    }
    if (add_path(ruleset_fd, argv[++i], access) != 0) {
      return APPLY_FAILED_EXIT_CODE;
    }
  }

  if (i >= argc) {
    fprintf(stderr, "alternative-helper: no command after --\n");
    return APPLY_FAILED_EXIT_CODE;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "alternative-helper: no_new_privs: %s\n", strerror(errno));
    return APPLY_FAILED_EXIT_CODE;
  }
  if (ll_restrict_self(ruleset_fd, 0) != 0) {
    fprintf(stderr, "alternative-helper: restrict_self: %s\n", strerror(errno));
    return APPLY_FAILED_EXIT_CODE;
  }
  close(ruleset_fd);

  /* execve, not fork: the helper becomes the command, so there is no extra
     process in the tree at all. This is the structural advantage over the
     bun:ffi shape, independent of startup cost. */
  execvp(argv[i], &argv[i]);
  fprintf(stderr, "alternative-helper: exec(%s): %s\n", argv[i], strerror(errno));
  return APPLY_FAILED_EXIT_CODE;
}
