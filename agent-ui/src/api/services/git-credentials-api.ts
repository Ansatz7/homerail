/**
 * ============================================================================
 * Git Credentials API - Git凭证管理API服务
 * ============================================================================
 *
 * 提供Git凭证的CRUD操作，使用后端实际的API端点路径
 * 已更新为使用新的GitServer单表设计
 *
 * 设计原则：
 * - 只管理Git访问凭据 - GitServer单表
 * - 实时获取数据 - 不预存分支/PR/用户元数据
 * - 保留Git操作能力 - 通过platforms适配器
 */

import { http } from '../clients/http-client'
import type { BaseResponse } from '../types/common.types'
import type {
  GitServer,
  GitServerCreateRequest,
  GitServerUpdateRequest,
  GitUserInfo,
  GitRepositoryInfo,
  GitBranchInfo,
  GitRepo,
  GitRepoCreateRequest,
  GitRepoUpdateRequest
} from '../types/infrastructure.types'

/**
 * Git仓库响应类型
 */
export interface GitCredentialResponse {
  success: boolean
  message: string
  data: {
    git_id: string
    repository_url: string
    user_email: string
    user_name: string
    description: string
    is_active: boolean
    created_at: string
  }
  error?: string | null
}

/**
 * Git仓库列表响应类型
 */
export interface GitCredentialsListResponse {
  success: boolean
  message: string
  data: {
    repositories: Array<{
      git_id: string
      repository_url: string
      user_email: string
      user_name: string
      description: string
      token_valid: boolean
      token_type: string
      last_verified: string | null
      is_active: boolean
      created_at: string
      updated_at: string
    }>
  }
  error?: string | null
}

// ============================================================================
// 新的GitServer API函数（推荐使用）
// ============================================================================

/**
 * GitServer列表响应类型
 */
export interface GitServerListResponse {
  success: boolean
  message: string
  data: {
    servers: GitServer[]
  }
}

/**
 * GitServer详情响应类型
 */
export interface GitServerDetailResponse {
  success: boolean
  message: string
  data: GitServer
}

/**
 * GitServer用户信息响应类型
 */
export interface GitServerUserResponse {
  success: boolean
  message: string
  data: {
    user: GitUserInfo
  }
}

/**
 * GitServer仓库信息响应类型
 */
export interface GitServerRepositoryResponse {
  success: boolean
  message: string
  data: {
    repository: GitRepositoryInfo
  }
}

/**
 * GitServer分支列表响应类型
 */
export interface GitServerBranchesResponse {
  success: boolean
  message: string
  data: {
    branches: GitBranchInfo[]
  }
}

/**
 * GitServer仓库列表响应类型
 */
export interface GitServerReposResponse {
  success: boolean
  message: string
  data: {
    repositories: GitRepositoryInfo[]
    page: number
    per_page: number
  }
}

/**
 * 创建GitServer配置
 */
export async function createGitServer(
  data: GitServerCreateRequest
): Promise<GitServerDetailResponse> {
  return http.post<GitServer>('/api/git-servers', data) as Promise<GitServerDetailResponse>
}

/**
 * 列出所有GitServer配置
 */
export async function listGitServers(
  active_only: boolean = true
): Promise<GitServerListResponse> {
  return http.get<{ servers: GitServer[] }>(
    `/api/git-servers?active_only=${active_only}`
  ) as Promise<GitServerListResponse>
}

/**
 * 获取单个GitServer配置
 */
export async function getGitServer(
  server_id: string
): Promise<GitServerDetailResponse> {
  return http.get<GitServer>(`/api/git-servers/${server_id}`) as Promise<GitServerDetailResponse>
}

/**
 * 更新GitServer配置
 */
export async function updateGitServer(
  server_id: string,
  data: GitServerUpdateRequest
): Promise<GitServerDetailResponse> {
  return http.put<GitServer>(
    `/api/git-servers/${server_id}`,
    data
  ) as Promise<GitServerDetailResponse>
}

/**
 * 删除GitServer配置
 */
export async function deleteGitServer(
  server_id: string,
  force: boolean = false
): Promise<BaseResponse<{ server_id: string }>> {
  return http.delete<{ server_id: string }>(
    `/api/git-servers/${server_id}?force=${force}`
  ) as Promise<BaseResponse<{ server_id: string }>>
}

/**
 * 验证GitServer的Token连接
 */
export async function verifyGitServer(
  server_id: string
): Promise<BaseResponse<{
  valid: boolean
  user_info?: GitUserInfo
  scopes?: string[]
  token_type?: string
}>> {
  return http.post<{
    valid: boolean
    user_info?: GitUserInfo
    scopes?: string[]
    token_type?: string
  }>(`/api/git-servers/${server_id}/verify`, {}) as Promise<BaseResponse<{
    valid: boolean
    user_info?: GitUserInfo
    scopes?: string[]
    token_type?: string
  }>>
}

/**
 * 获取GitServer关联的用户信息（实时查询）
 */
export async function getGitServerUser(
  server_id: string
): Promise<GitServerUserResponse> {
  return http.get<{ user: GitUserInfo }>(
    `/api/git-servers/${server_id}/user`
  ) as Promise<GitServerUserResponse>
}

/**
 * 获取GitServer关联的仓库信息（实时查询）
 */
export async function getGitServerRepository(
  server_id: string,
  owner: string,
  repo_name: string
): Promise<GitServerRepositoryResponse> {
  return http.get<{ repository: GitRepositoryInfo }>(
    `/api/git-servers/${server_id}/repository?owner=${encodeURIComponent(owner)}&repo_name=${encodeURIComponent(repo_name)}`
  ) as Promise<GitServerRepositoryResponse>
}

/**
 * 获取仓库分支列表（实时查询）
 */
export async function getGitServerBranches(
  server_id: string,
  owner: string,
  repo_name: string,
  page: number = 1,
  per_page: number = 30
): Promise<GitServerBranchesResponse> {
  return http.get<{ branches: GitBranchInfo[] }>(
    `/api/git-servers/${server_id}/branches?owner=${encodeURIComponent(owner)}&repo_name=${encodeURIComponent(repo_name)}&page=${page}&per_page=${per_page}`
  ) as Promise<GitServerBranchesResponse>
}

/**
 * 列出用户的所有仓库（实时查询）
 */
export async function listGitServerRepos(
  server_id: string,
  page: number = 1,
  per_page: number = 30
): Promise<GitServerReposResponse> {
  return http.get<{
    repositories: GitRepositoryInfo[]
    page: number
    per_page: number
  }>(
    `/api/git-servers/${server_id}/repos?page=${page}&per_page=${per_page}`
  ) as Promise<GitServerReposResponse>
}

/**
 * 验证Token是否有效（不保存，仅验证）
 */
export async function verifyTokenOnly(
  platform_type: string,
  api_endpoint: string,
  token: string
): Promise<BaseResponse<{
  valid: boolean
  platform: string
  user: GitUserInfo
  scopes?: string[]
  token_type?: string
}>> {
  return http.post<{
    valid: boolean
    platform: string
    user: GitUserInfo
    scopes?: string[]
    token_type?: string
  }>('/api/git-servers/verify-token', null, {
    params: {
      platform_type,
      api_endpoint
    },
    data: { token }
  }) as Promise<BaseResponse<{
    valid: boolean
    platform: string
    user: GitUserInfo
    scopes?: string[]
    token_type?: string
  }>>
}

// ============================================================================
// 旧的Git凭证API函数（保留兼容）
// ============================================================================
export async function addGitCredential(data: {
  url: string
  credential_type?: string
  credential_data: string
  username?: string
  email?: string
  description?: string
}): Promise<GitCredentialResponse> {
  return http.post<GitCredentialResponse['data']>('/api/git', data) as Promise<GitCredentialResponse>
}

/**
 * 列出Git仓库
 */
export async function listGitCredentials(params?: {
  url?: string
  credential_type?: string
}): Promise<GitCredentialsListResponse> {
  const queryParams = new URLSearchParams()

  if (params?.url) queryParams.append('url', params.url)
  if (params?.credential_type) queryParams.append('credential_type', params.credential_type)

  const queryString = queryParams.toString()
  return http.get<GitCredentialsListResponse['data']>(
    `/api/git${queryString ? `?${queryString}` : ''}`
  ) as Promise<GitCredentialsListResponse>
}

/**
 * 获取Git仓库详情
 */
export async function getGitCredential(gitId: string): Promise<GitCredentialResponse> {
  return http.get<GitCredentialResponse['data']>(`/api/git/${gitId}`) as Promise<GitCredentialResponse>
}

/**
 * 删除Git仓库（软删除）
 */
export async function deleteGitCredential(
  gitId: string,
  force: boolean = false
): Promise<BaseResponse<{ git_id: string }>> {
  return http.delete<{ git_id: string }>(
    `/api/git/${gitId}?force=${force}`
  ) as Promise<BaseResponse<{ git_id: string }>>
}

/**
 * 验证Git仓库凭证
 */
export async function verifyGitCredential(gitId: string): Promise<BaseResponse<{
  verified: boolean
  message: string
  scopes?: string[]
}>> {
  return http.post<{
    verified: boolean
    message: string
    scopes?: string[]
  }>(`/api/git/${gitId}/verify`, {}) as Promise<BaseResponse<{
    verified: boolean
    message: string
    scopes?: string[]
  }>>
}

/**
 * 验证 Git Token 是否有效（不保存）
 * 返回用户信息：user_login, user_name, user_email
 */
export async function verifyGitToken(data: {
  url: string
  credential_type?: string
  credential_data: string
  username?: string
  email?: string
  description?: string
}): Promise<BaseResponse<{
  valid: boolean
  user_login?: string
  user_name?: string
  user_email?: string
}>> {
  return http.post<{
    valid: boolean
    user_login?: string
    user_name?: string
    user_email?: string
  }>('/api/git/verify', data) as Promise<BaseResponse<{
    valid: boolean
    user_login?: string
    user_name?: string
    user_email?: string
  }>>
}

/**
 * 更新Git仓库凭证
 */
export async function updateGitCredential(
  gitId: string,
  data: {
    url?: string
    credential_type?: string
    credential_data?: string
    username?: string
    email?: string
    description?: string
  }
): Promise<GitCredentialResponse> {
  return http.put<GitCredentialResponse['data']>(`/api/git/${gitId}`, data) as Promise<GitCredentialResponse>
}

// ============================================================================
// Export API Object
// ============================================================================

export const gitCredentialsApi = {
  // 新的GitServer API函数（推荐使用）
  createGitServer,
  listGitServers,
  getGitServer,
  updateGitServer,
  deleteGitServer,
  verifyGitServer,
  getGitServerUser,
  getGitServerRepository,
  getGitServerBranches,
  listGitServerRepos,
  verifyTokenOnly,

  // 旧的Git凭证API函数（保留兼容）
  addGitCredential,
  listGitCredentials,
  getGitCredential,
  deleteGitCredential,
  verifyGitCredential,
  updateGitCredential
}
