import { readFileSync } from 'fs';
import { join } from 'path';

describe('fetch-core GitHub Release 下载重试', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/fetch-core.mjs'), 'utf8');

  it('覆盖 connection reset 等普通 --retry 不处理的瞬态传输错误', () => {
    expect(source).toContain("'--retry-all-errors'");
    expect(source).toContain("'--retry-delay'");
    expect(source).toContain("'--connect-timeout'");
    expect(source).toContain("'--max-time'");
  });

  it('所有核心资产下载都复用同一组重试参数', () => {
    expect(source).toContain(
      "execFileSync('curl', ['-fL', ...CURL_RETRY_ARGS, '-o', archive, url]"
    );
  });
});
