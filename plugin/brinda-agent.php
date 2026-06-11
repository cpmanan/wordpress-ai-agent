<?php
/**
 * Plugin Name: Brinda Agent API
 * Description: REST API endpoints for the WordPress AI Agent (Railway → WP Engine over HTTPS)
 * Version: 2.0
 * Author: Brinda AI Agent
 */

if (!defined('ABSPATH')) exit;

add_action('rest_api_init', function () {

  // ── Auth helper ────────────────────────────────────────────────────────────
  // All write endpoints require WP Application Password (Basic Auth).
  // Read endpoints also require auth so the plugin isn't publicly exploitable.
  function brinda_auth($request) {
    $user = wp_get_current_user();
    if (!$user || !$user->ID) return new WP_Error('unauthorized', 'Authentication required', ['status' => 401]);
    if (!current_user_can('manage_options')) return new WP_Error('forbidden', 'Insufficient permissions', ['status' => 403]);
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/site-info
  // Returns everything siteKnowledge.js needs in ONE request
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/site-info', [
    'methods'             => 'GET',
    'callback'            => 'brinda_site_info',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/elementor-data?post_id=123
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/elementor-data', [
    'methods'             => 'GET',
    'callback'            => 'brinda_get_elementor_data',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // POST /wp-json/brinda-agent/v1/elementor-data
  // Body: { post_id, elementor_data }
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/elementor-data', [
    'methods'             => 'POST',
    'callback'            => 'brinda_save_elementor_data',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // POST /wp-json/brinda-agent/v1/flush-cache
  // Body: { post_id }
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/flush-cache', [
    'methods'             => 'POST',
    'callback'            => 'brinda_flush_cache',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/cpt-posts?post_type=cpt_services&cat_id=62
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/cpt-posts', [
    'methods'             => 'GET',
    'callback'            => 'brinda_get_cpt_posts',
    'permission_callback' => 'brinda_auth',
  ]);
});

// ── /site-info ─────────────────────────────────────────────────────────────
function brinda_site_info() {
  // Site options
  $front_page_id = (int) get_option('page_on_front');
  $blog_page_id  = (int) get_option('page_for_posts');

  // All pages
  $raw_pages = get_posts([
    'post_type'      => 'page',
    'post_status'    => ['publish', 'draft'],
    'posts_per_page' => -1,
    'fields'         => 'all',
  ]);
  $pages = array_map(function($p) use ($front_page_id) {
    $template = get_post_meta($p->ID, '_wp_page_template', true) ?: 'default';
    $uses_elementor = get_post_meta($p->ID, '_elementor_edit_mode', true) === 'builder';
    return [
      'id'            => $p->ID,
      'title'         => $p->post_title,
      'slug'          => $p->post_name,
      'status'        => $p->post_status,
      'template'      => $template,
      'uses_elementor'=> $uses_elementor,
      'is_front_page' => $p->ID === $front_page_id,
    ];
  }, $raw_pages);

  // Elementor pages subset
  $elementor_pages = array_values(array_filter($pages, fn($p) => $p['uses_elementor']));

  // Recent posts
  $raw_posts = get_posts([
    'post_type'      => 'post',
    'post_status'    => 'publish',
    'posts_per_page' => 30,
  ]);
  $posts = array_map(fn($p) => [
    'id'    => $p->ID,
    'title' => $p->post_title,
    'slug'  => $p->post_name,
    'date'  => $p->post_date,
  ], $raw_posts);

  // Navigation menus
  $nav_menus = wp_get_nav_menus();
  $menus = [];
  foreach ($nav_menus as $menu) {
    $items = wp_get_nav_menu_items($menu->term_id) ?: [];
    $menus[] = [
      'id'    => $menu->term_id,
      'name'  => $menu->name,
      'slug'  => $menu->slug,
      'items' => array_map(fn($i) => [
        'id'        => $i->ID,
        'title'     => $i->title,
        'url'       => $i->url,
        'type'      => $i->object,
        'object_id' => (int) $i->object_id,
        'parent_id' => (int) $i->menu_item_parent ?: null,
      ], $items),
    ];
  }

  // Active plugins
  $all_plugins    = get_plugins();
  $active_plugins = get_option('active_plugins', []);
  $plugins = [];
  foreach ($all_plugins as $slug => $data) {
    $plugins[] = [
      'slug'    => $slug,
      'title'   => $data['Name'],
      'version' => $data['Version'],
      'status'  => in_array($slug, $active_plugins) ? 'active' : 'inactive',
    ];
  }

  // Custom post types (public, non-built-in)
  $cpts = get_post_types(['public' => true, '_builtin' => false], 'objects');
  $custom_post_types = array_values(array_map(fn($cpt) => [
    'slug'  => $cpt->name,
    'label' => $cpt->label,
  ], $cpts));

  return rest_ensure_response([
    'generated_at'      => current_time('c'),
    'site'              => [
      'blogname' => get_bloginfo('name'),
      'siteurl'  => get_bloginfo('url'),
    ],
    'front_page_id'     => $front_page_id ?: null,
    'blog_page_id'      => $blog_page_id  ?: null,
    'theme'             => [
      'child'  => get_stylesheet(),
      'parent' => get_template(),
    ],
    'pages'             => $pages,
    'elementor_pages'   => $elementor_pages,
    'posts'             => $posts,
    'menus'             => $menus,
    'plugins'           => $plugins,
    'custom_post_types' => $custom_post_types,
  ]);
}

// ── /elementor-data GET ────────────────────────────────────────────────────
function brinda_get_elementor_data(WP_REST_Request $request) {
  $post_id = (int) $request->get_param('post_id');
  if (!$post_id) return new WP_Error('missing_param', 'post_id required', ['status' => 400]);

  $data = get_post_meta($post_id, '_elementor_data', true);
  return rest_ensure_response([
    'post_id'       => $post_id,
    'elementor_data'=> $data ?: '',
  ]);
}

// ── /elementor-data POST ───────────────────────────────────────────────────
function brinda_save_elementor_data(WP_REST_Request $request) {
  $post_id        = (int) $request->get_param('post_id');
  $elementor_data = $request->get_param('elementor_data');

  if (!$post_id)        return new WP_Error('missing_param', 'post_id required',        ['status' => 400]);
  if (!$elementor_data) return new WP_Error('missing_param', 'elementor_data required', ['status' => 400]);

  update_post_meta($post_id, '_elementor_data', wp_slash($elementor_data));

  // Clear all Elementor cache for this post
  delete_post_meta($post_id, '_elementor_css');
  delete_post_meta($post_id, '_elementor_element_cache');
  delete_post_meta($post_id, '_elementor_page_assets');

  // Elementor core cache
  if (class_exists('\Elementor\Plugin')) {
    try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
    try { \Elementor\Plugin::$instance->posts_css_manager->clear_cache(); } catch (\Throwable $e) {}
  }

  wp_cache_flush();

  return rest_ensure_response(['success' => true, 'post_id' => $post_id]);
}

// ── /flush-cache POST ──────────────────────────────────────────────────────
function brinda_flush_cache(WP_REST_Request $request) {
  $post_id = (int) $request->get_param('post_id');

  if ($post_id) {
    delete_post_meta($post_id, '_elementor_css');
    delete_post_meta($post_id, '_elementor_element_cache');
    delete_post_meta($post_id, '_elementor_page_assets');
  }

  if (class_exists('\Elementor\Plugin')) {
    try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
  }

  wp_cache_flush();

  // WP Engine object cache purge
  if (function_exists('wpecommon_purge_varnish_cache_all')) {
    wpecommon_purge_varnish_cache_all();
  }

  return rest_ensure_response(['success' => true, 'flushed_post_id' => $post_id]);
}

// ── /cpt-posts GET ─────────────────────────────────────────────────────────
function brinda_get_cpt_posts(WP_REST_Request $request) {
  $post_type = sanitize_key($request->get_param('post_type') ?: 'cpt_services');
  $cat_id    = (int) $request->get_param('cat_id');

  $args = [
    'post_type'      => $post_type,
    'post_status'    => 'publish',
    'posts_per_page' => -1,
  ];

  if ($cat_id) {
    // Determine the taxonomy slug (convention: post_type + '_group')
    $tax_slug = $post_type . '_group';
    $args['tax_query'] = [[
      'taxonomy' => $tax_slug,
      'field'    => 'term_id',
      'terms'    => $cat_id,
    ]];
  }

  $raw = get_posts($args);
  $posts = array_map(fn($p) => [
    'id'     => $p->ID,
    'title'  => $p->post_title,
    'status' => $p->post_status,
    'slug'   => $p->post_name,
  ], $raw);

  return rest_ensure_response([
    'post_type' => $post_type,
    'cat_id'    => $cat_id,
    'count'     => count($posts),
    'posts'     => $posts,
  ]);
}
