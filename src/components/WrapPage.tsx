import cloneDeep from 'lodash/cloneDeep';
import gql from 'graphql-tag';
import pick from 'lodash/pick';
import get from 'lodash/get';
import { pathToRegexp, match as matchRegex, Key } from 'path-to-regexp';

import Prismic from 'prismic-javascript';
import React from 'react';
import traverse from 'traverse';
import { fieldName, getCookies, typeName } from '../utils';
import { createLoadingScreen } from '../utils/createLoadingScreen';
import { getApolloClient } from '../utils/getApolloClient';
import { parseQueryString, parseQueryStringAsJson } from '../utils/parseQueryString';

const queryOrSource = (obj: any) => {
  if (typeof obj === 'string') {
    return obj.replace(/\s+/g, ' ');
  } else if (obj.source) {
    return String(obj.source).replace(/\s+/g, ' ');
  }
  return null;
};

const stripSharp = (query: any) => {
  return traverse(query).map(function(x) {
    if (
      typeof x === 'object' &&
      x.kind == 'Name' &&
      this.parent &&
      this.parent.node.kind === 'Field' &&
      x.value.match(/Sharp$/) &&
      !x.value.match(/.+childImageSharp$/)
    ) {
      this.parent.remove();
    }
  });
};

interface WrapPageState {
  data: any;
  loading: boolean;
  error: Error | null;
}

export class WrapPage extends React.PureComponent<any, WrapPageState> {
  state: WrapPageState = {
    data: this.props.data,
    loading: false,
    error: null,
  };

  keys = ['uid', 'id', 'lang'];

  get params() {
    const params: any = { ...this.props.pageContext };

    const keys: Key[] = [];
    const re = pathToRegexp(get(this.props.pageContext, 'matchPath', ''), keys);
    const match = re.exec(get(this.props, 'location.pathname', ''));

    const matchFn = matchRegex(get(this.props.pageContext, 'matchPath', ''), {
      decode: decodeURIComponent,
    });

    const pathParams = (() => {
      const res = matchFn(get(this.props, 'location.pathname', ''));
      return res ? res.params : {};
    })();

    const qsParams = (() => {
      const qsValue = String(get(this.props, 'location.search', '?')).substr(1);
      return parseQueryStringAsJson(qsValue);
    })();

    return Object.assign(params, qsParams, pathParams);
  }

  getQuery() {
    const child = this.props.children as any;
    let query = queryOrSource(get(this.props.pageContext, 'rootQuery')) || '';

    if (child && child.type) {
      if (child.type.query) {
        query = queryOrSource(child.type.query) || '';
      }

      if (child.type.fragments && Array.isArray(child.type.fragments)) {
        child.type.fragments.forEach((fragment: any) => {
          query += queryOrSource(fragment);
        });
      }
    }

    return query;
  }

  componentDidMount() {
    const { pageContext, options } = this.props;
    const cookies = getCookies();
    const hasCookie = cookies.has(Prismic.experimentCookie) || cookies.has(Prismic.previewCookie);

    if (pageContext.rootQuery && options.previews !== false && hasCookie) {
      const closeLoading = createLoadingScreen();
      this.setState({ loading: true });
      this.load()
        .then(res => {
          this.setState({
            loading: false,
            error: null,
            data: { ...this.state.data, prismic: res.data },
          });
          closeLoading();
        })
        .catch(error => {
          this.setState({ loading: false, error });
          console.error(error);
          closeLoading();
        });
    }
  }

  load = ({ variables = {}, query, fragments = [], ...rest }: any = {}) => {
    if (!query) {
      query = this.getQuery();
    } else {
      query = queryOrSource(query);
    }

    fragments.forEach((fragment: any) => {
      query += queryOrSource(fragment);
    });

    const keys = [...(this.props.options.passContextKeys || []), ...this.keys];
    variables = { ...pick(this.params, keys), ...variables };

    return getApolloClient(this.props.options).then(client => {
      return client.query({
        query: stripSharp(getIsolatedQuery(query, fieldName, typeName)),
        fetchPolicy: 'no-cache',
        variables,
        ...rest,
      });
    });
  };

  render() {
    const children = this.props.children as any;

    return React.cloneElement(children, {
      ...children.props,
      prismic: {
        options: this.props.options,
        loading: this.state.loading,
        error: this.state.error,
        load: this.load,
      },
      data: this.state.data,
    });
  }
}

function getQuery(query: any) {
  if (typeof query === 'object' && query.definitions) {
    return query;
  } else if (typeof query === 'string') {
    return gql(query);
  } else if (typeof query === 'object' && query.source) {
    return gql(query.source);
  } else {
    throw new Error('Could not parse query: ' + query);
  }
}

function getIsolatedQuery(querySource: string, fieldName: string, typeName: string) {

  const query = getQuery(querySource);
  const updatedQuery = cloneDeep(query);

  const updatedRoot = updatedQuery.definitions[0].selectionSet.selections
  .find((selection: any) => selection.name && selection.name.kind === 'Name' && selection.name.value === fieldName);

  if (updatedRoot) {
    updatedQuery.definitions[0].selectionSet.selections = updatedRoot.selectionSet.selections;
  } else if (fieldName) {
    console.warn('Failed to update query root');
    return;
  }

  traverse(updatedQuery).forEach(function (x) {
    if (this.isLeaf && this.parent && this.parent.key === 'name') {
      if (this.parent.parent && this.parent.parent.node.kind === 'NamedType') {
        if (typeof x === 'string' && x.indexOf(`${typeName}_`) === 0) {
          this.update(x.substr(typeName.length + 1));
        }
      }
    }
  });

  return updatedQuery;
}