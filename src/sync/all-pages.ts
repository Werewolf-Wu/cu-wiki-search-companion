// SPDX-License-Identifier: MPL-2.0
import type { WikiApi } from './wiki-api';

export interface AllPagesResponse {
  continue?: { gapcontinue?: string };
  query?: {
    pages?: Array<{
      pageid: number;
      ns: number;
      title: string;
      redirect?: boolean;
      lastrevid?: number;
      contentmodel?: string;
    }>;
  };
}

interface AllPagesRequest {
  namespace: number;
  gapcontinue?: string;
  assert?: 'user';
}

export function requestAllPages(
  api: WikiApi,
  { namespace, gapcontinue, assert }: AllPagesRequest,
): Promise<AllPagesResponse> {
  return api.query<AllPagesResponse>({
    ...(assert ? { assert } : {}),
    generator: 'allpages',
    prop: 'info',
    gaplimit: 500,
    gapnamespace: namespace,
    ...(gapcontinue ? { gapcontinue } : {}),
  });
}
